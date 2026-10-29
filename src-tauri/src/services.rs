//! Local tools (T3 Code, Paperclip) that a tab needs running before it can load.
//!
//! The programs are fixed here rather than passed in from the UI, so nothing in a
//! webview can make the shell start an arbitrary process.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
/// Longest a cleanup helper (pg_ctl, the leftover search) may run.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to keep looking for a pairing URL after the tool serves pages (x 500 ms).
const PAIRING_WAIT_STEPS: u32 = 20;

struct Spec {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    port: u16,
    /// Log-line prefix of a one-time URL that signs the tab in, printed at startup.
    pairing_prefix: Option<&'static str>,
    /// A folder only this tool runs programs from. Anything running from it
    /// that outlived the tool (Paperclip's database survives its Node process,
    /// and a crash or power loss skips cleanup) is stopped before a start and
    /// on quit.
    owned_dir: Option<PathBuf>,
    /// A program that shuts the tool's helpers down cleanly, run before a
    /// start and on quit, ahead of any force-stop.
    shutdown: Option<(PathBuf, Vec<String>)>,
    /// Treat a running process with exactly these arguments as this shell's
    /// own (an orphan after a crash or force-quit) and stop it. Without its
    /// startup log the tab can't be signed in (T3 Code pairing), so it's
    /// replaced with a fresh start. A T3 Code the user runs another way has
    /// other arguments and is left alone.
    owned_by_args: bool,
    /// Extra environment for the tool's process.
    env: Vec<(&'static str, String)>,
    /// When the tool counts as ready to show.
    ready: Ready,
}

impl Spec {
    /// Command-line fragments that mark a process as this tool's leftover.
    /// Backslash-separated: command lines are compared with `/` turned into
    /// `\`, since tools mix them (`...\paperclip/node_modules/...`).
    fn leftover_markers(&self) -> Vec<String> {
        let mut markers = Vec::new();
        if let Some(dir) = &self.owned_dir {
            markers.push(format!("{}\\", dir.to_string_lossy().replace('/', "\\")));
        }
        if self.owned_by_args {
            markers.push(self.args.join(" "));
        }
        markers
    }
}

fn env_path(var: &str) -> Result<PathBuf, String> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{var} is not set"))
}

fn spec(id: &str) -> Result<Spec, String> {
    let home = env_path("USERPROFILE")?;
    match id {
        // `npm install -g t3`. Web mode accepts the printed pairing URL (desktop
        // mode only trusts T3 Code's own app); `--host` keeps it on loopback.
        "t3" => Ok(Spec {
            program: env_path("APPDATA")?.join("npm").join("t3.cmd"),
            args: [
                "serve",
                "--mode",
                "web",
                "--host",
                "127.0.0.1",
                "--port",
                "3773",
                "--no-browser",
            ]
            .map(String::from)
            .to_vec(),
            cwd: home,
            port: 3773,
            pairing_prefix: Some("Pairing URL: "),
            owned_dir: None,
            shutdown: None,
            owned_by_args: true,
            env: Vec::new(),
            ready: Ready { path: "/", body_contains: None },
        }),
        // Paperclip runs on the system's native Node (ARM64 here), about three
        // times faster to start than emulated x64. Its embedded PostgreSQL has
        // no ARM64 Windows build, so shell/tools/patch-paperclip.mjs points it
        // at the x64 one, which Windows emulates. Without a system Node, or
        // before the ARM64 image library is installed, the bundled x64 Node
        // runs everything.
        "paperclip" => {
            let tools = env_path("LOCALAPPDATA")?.join("shell-tools");
            let native = env_path("ProgramFiles")?.join("nodejs").join("node.exe");
            let arm64_ready = tools
                .join("paperclip/node_modules/@img/sharp-win32-arm64")
                .exists();
            Ok(Spec {
                program: if native.exists() && arm64_ready {
                    native
                } else {
                    tools.join("node-x64").join("node.exe")
                },
                args: vec![
                    tools
                        .join("paperclip/node_modules/paperclipai/dist/index.js")
                        .to_string_lossy()
                        .into_owned(),
                    "run".into(),
                ],
                port: 3100,
                pairing_prefix: None,
                // Its PostgreSQL runs under a restricted token that outlives
                // the Node process; `pg_ctl stop` ends it cleanly.
                shutdown: Some((
                    tools.join(
                        "paperclip/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe",
                    ),
                    vec![
                        "stop".into(),
                        "-D".into(),
                        home.join(".paperclip/instances/default/db")
                            .to_string_lossy()
                            .into_owned(),
                        "-m".into(),
                        "fast".into(),
                        "-w".into(),
                        "-t".into(),
                        "15".into(),
                    ],
                )),
                owned_dir: Some(tools.join("paperclip")),
                owned_by_args: false,
                env: vec![
                    // Most of Paperclip's start is loading thousands of JS
                    // files; Node's on-disk compile cache cuts that on every
                    // start after the first.
                    (
                        "NODE_COMPILE_CACHE",
                        tools.join("node-compile-cache").to_string_lossy().into_owned(),
                    ),
                    // Skip the npm registry lookup at start (up to 2.5s offline).
                    ("PAPERCLIP_UPDATE_CHECK", "0".into()),
                ],
                // Its health says "starting" until startup recovery is done;
                // before that its page shows "Reconnecting to Paperclip".
                ready: Ready {
                    path: "/api/health",
                    body_contains: Some(r#""status":"ok""#),
                },
                cwd: home,
            })
        }
        _ => Err(format!("unknown service {id}")),
    }
}

#[derive(Default)]
struct Started {
    child: Option<Child>,
    /// Log length when this run started, so pairing lines from older runs are ignored.
    log_offset: u64,
    /// One-time sign-in URL found in this run's log, handed to the tab once.
    pairing_url: Option<String>,
}

#[derive(Default)]
pub struct Services(Mutex<HashMap<String, Started>>);

/// The last line in `log` after `offset` that starts with `prefix`, minus the prefix.
fn find_after(log: &Path, offset: u64, prefix: &str) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = File::open(log).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| line.trim().strip_prefix(prefix).map(|rest| rest.trim().to_owned()))
        .last()
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// How to tell a tool is ready for its tab: `GET path` answers without a server
/// error and, if `body_contains` is set, the body says so. A listening port is
/// not enough: T3 Code answers 503 for a while after it binds, and Paperclip
/// serves its page before its API finishes startup recovery.
struct Ready {
    path: &'static str,
    body_contains: Option<&'static str>,
}

fn http_ready(port: u16, ready: &Ready) -> bool {
    use std::io::{Read, Write};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET {} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n", ready.path);
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    // HTTP/1.0: the server closes after the response. Health answers are
    // small; 64 KiB is plenty and bounds a page that isn't.
    let mut response = Vec::new();
    let _ = stream.take(64 * 1024).read_to_end(&mut response);
    let response = String::from_utf8_lossy(&response);
    // "HTTP/1.1 200 ..." -> the status code sits at bytes 9..12.
    let ok_status = response
        .get(9..12)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| code < 500);
    ok_status && ready.body_contains.is_none_or(|needle| response.contains(needle))
}

/// Stop every process whose command line contains one of `markers`.
///
/// PostgreSQL runs under a restricted token, which hides its program path from
/// ordinary process queries, and an orphaned worker survives `pg_ctl stop`
/// while holding the database's shared memory. WMI still reports the command
/// line, so match on that.
#[cfg(windows)]
fn kill_processes_matching(markers: &[String]) {
    if markers.is_empty() {
        return;
    }
    // Single quotes inside a PowerShell single-quoted string are doubled.
    let quoted: Vec<String> = markers
        .iter()
        .map(|m| format!("'{}'", m.replace('\'', "''")))
        .collect();
    // The script's own command line contains the markers: skip itself ($PID),
    // or it can stop itself before reaching the leftovers.
    let script = format!(
        "$marks = @({}); Get-CimInstance Win32_Process | Where-Object {{ $c = $_.CommandLine; $_.ProcessId -ne $PID -and $c -and ($c = $c.Replace('/', '\\')) -and ($marks | Where-Object {{ $c.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }}) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
        quoted.join(", "),
    );
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    run_hidden(command, CLEANUP_TIMEOUT);
}

#[cfg(not(windows))]
fn kill_processes_matching(_markers: &[String]) {}

/// Run a helper program without a window, giving up on it after `timeout` so
/// a stuck helper can't stall a tool's start or the shell's quit.
fn run_hidden(mut command: Command, timeout: Duration) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let begun = Instant::now();
    while let Ok(None) = child.try_wait() {
        if begun.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn last_lines(path: &Path, count: usize) -> String {
    let Ok(file) = File::open(path) else {
        return String::new();
    };
    let lines: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn spawn(spec: &Spec, log: &Path) -> Result<Child, String> {
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("can't open log {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    // `.cmd` shims have to go through cmd.exe.
    let mut command = if spec.program.extension().is_some_and(|ext| ext == "cmd") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&spec.program);
        c
    } else {
        Command::new(&spec.program)
    };
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(spec.env.iter().map(|(key, value)| (*key, value.as_str())))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|e| format!("can't start {}: {e}", spec.program.display()))
}

/// Start the tool behind tab `id` unless it is already listening, then wait
/// until it serves pages. Returns a one-time sign-in URL the first time a run
/// that this shell started is ready, if the tool prints one.
#[tauri::command]
pub async fn ensure_service(
    app: AppHandle,
    services: State<'_, Services>,
    id: String,
) -> Result<Option<String>, String> {
    let spec = spec(&id)?;
    let take_pairing = || -> Result<Option<String>, String> {
        let mut started = services.0.lock().map_err(|e| e.to_string())?;
        Ok(started.get_mut(&id).and_then(|s| s.pairing_url.take()))
    };
    let ours = services
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .is_some_and(|s| s.child.is_some());
    if http_ready(spec.port, &spec.ready) {
        if ours {
            return take_pairing();
        }
        if !spec.owned_by_args {
            // An orphan from a crash or force-quit that needs no sign-in
            // (Paperclip): adopt it, so quitting the shell still stops it.
            if !spec.leftover_markers().is_empty() {
                services
                    .0
                    .lock()
                    .map_err(|e| e.to_string())?
                    .entry(id.clone())
                    .or_default();
            }
            return Ok(None);
        }
        // Running, but not started by this run of the shell: an orphan from a
        // crash or force-quit, whose sign-in URL we never saw. Replace it.
        clean_up_leftovers_in_background(&id).await?;
        for _ in 0..20 {
            if !port_open(spec.port) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if port_open(spec.port) {
            // Something else holds the port (not ours to stop); use it as is.
            return Ok(None);
        }
    }
    if !spec.program.exists() {
        return Err(format!(
            "{} isn't installed (expected {})",
            id,
            spec.program.display()
        ));
    }

    let logs = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log = logs.join(format!("{id}.log"));

    let running = || -> Result<bool, String> {
        let mut started = services.0.lock().map_err(|e| e.to_string())?;
        Ok(match started.get_mut(&id).and_then(|s| s.child.as_mut()) {
            Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        })
    };
    // A tool that's already listening (started outside the shell, or still
    // warming up) only needs waiting for.
    if !running()? && !port_open(spec.port) {
        // Without holding the lock: cleanup can take seconds, and the other
        // tool's start must not wait on it.
        clean_up_leftovers_in_background(&id).await?;
        let mut started = services.0.lock().map_err(|e| e.to_string())?;
        // Another call may have started it during the cleanup.
        let started_meanwhile = started
            .get_mut(&id)
            .and_then(|s| s.child.as_mut())
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
        if !started_meanwhile {
            let log_offset = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
            let child = spawn(&spec, &log)?;
            started.insert(
                id.clone(),
                Started {
                    child: Some(child),
                    log_offset,
                    pairing_url: None,
                },
            );
        }
    }

    let begun = Instant::now();
    loop {
        if http_ready(spec.port, &spec.ready) {
            if let Some(prefix) = spec.pairing_prefix {
                let offset = {
                    let started = services.0.lock().map_err(|e| e.to_string())?;
                    started
                        .get(&id)
                        .filter(|s| s.child.is_some() && s.pairing_url.is_none())
                        .map(|s| s.log_offset)
                };
                if let Some(offset) = offset {
                    // T3 Code prints the URL a moment after it starts serving.
                    let mut found = None;
                    for _ in 0..PAIRING_WAIT_STEPS {
                        found = find_after(&log, offset, prefix);
                        if found.is_some() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    let mut started = services.0.lock().map_err(|e| e.to_string())?;
                    if let Some(run) = started.get_mut(&id) {
                        run.pairing_url = found;
                    }
                }
            }
            return take_pairing();
        }
        {
            let mut started = services.0.lock().map_err(|e| e.to_string())?;
            if let Some(child) = started.get_mut(&id).and_then(|s| s.child.as_mut()) {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    started.remove(&id);
                    return Err(format!(
                        "{id} exited ({status}). Last log lines:\n{}",
                        last_lines(&log, 12)
                    ));
                }
            }
        }
        if begun.elapsed() > STARTUP_TIMEOUT {
            return Err(format!(
                "{id} didn't start within {}s. Log: {}",
                STARTUP_TIMEOUT.as_secs(),
                log.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// End a tool's helpers that may outlive it: a clean shutdown first, then a
/// force-stop of anything still running from its own folder.
fn clean_up_leftovers(spec: &Spec) {
    if let Some((program, args)) = &spec.shutdown {
        if program.exists() {
            let mut command = Command::new(program);
            command.args(args);
            run_hidden(command, CLEANUP_TIMEOUT);
        }
    }
    kill_processes_matching(&spec.leftover_markers());
}

/// `clean_up_leftovers` off the async runtime: it waits on helper programs.
async fn clean_up_leftovers_in_background(id: &str) -> Result<(), String> {
    let spec = spec(id)?;
    tokio::task::spawn_blocking(move || clean_up_leftovers(&spec))
        .await
        .map_err(|e| e.to_string())
}

/// Kill a tool's process and everything it spawned.
fn stop_child(mut child: Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `.cmd` shims and Node spawn children; kill the whole tree.
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stop tool `id` (if this shell started it) and its leftovers, so the next
/// `ensure_service` starts it fresh.
#[tauri::command]
pub async fn restart_service(services: State<'_, Services>, id: String) -> Result<(), String> {
    spec(&id)?;
    let run = services.0.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(child) = run.and_then(|r| r.child) {
        stop_child(child);
    }
    clean_up_leftovers_in_background(&id).await
}

/// Show tool `id`'s log file in File Explorer.
#[tauri::command]
pub async fn reveal_log(app: AppHandle, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    spec(&id)?;
    let log = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{id}.log"));
    if !log.exists() {
        return Err(format!("{id} hasn't written a log yet"));
    }
    app.opener()
        .reveal_item_in_dir(&log)
        .map_err(|e| e.to_string())
}

/// Stop every tool this shell started, including their child processes.
pub fn stop_all(services: &Services) {
    let Ok(mut started) = services.0.lock() else {
        return;
    };
    let specs: Vec<Spec> = started.keys().filter_map(|id| spec(id).ok()).collect();
    for child in started.drain().filter_map(|(_, s)| s.child) {
        stop_child(child);
    }
    for spec in &specs {
        clean_up_leftovers(spec);
    }
}
