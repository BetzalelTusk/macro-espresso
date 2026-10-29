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
        }),
        // Paperclip runs on x64 Node: its embedded PostgreSQL has no ARM64
        // Windows build, and x64 runs under Windows' emulation.
        "paperclip" => {
            let tools = env_path("LOCALAPPDATA")?.join("shell-tools");
            Ok(Spec {
                program: tools.join("node-x64").join("node.exe"),
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

/// Whether the tool answers `GET /` without a server error. A listening port is
/// not enough: T3 Code answers 503 for a while after it binds.
fn http_ready(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    let Ok(read) = stream.read(&mut head) else {
        return false;
    };
    // "HTTP/1.1 200 ..." -> the status code sits at bytes 9..12.
    std::str::from_utf8(&head[..read])
        .ok()
        .and_then(|line| line.get(9..12))
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| code < 500)
}

/// Stop every process started from a program under `dir`.
///
/// PostgreSQL runs under a restricted token, which hides its program path from
/// ordinary process queries, and an orphaned worker survives `pg_ctl stop`
/// while holding the database's shared memory. WMI still reports the command
/// line, so match on that, in either slash style.
#[cfg(windows)]
fn kill_processes_under(dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let back = dir.to_string_lossy().replace('/', "\\");
    let forward = back.replace('\\', "/");
    // Single quotes inside a PowerShell single-quoted string are doubled.
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = format!(
        "$dirs = @({}, {}); Get-CimInstance Win32_Process | Where-Object {{ $c = $_.CommandLine; $c -and ($dirs | Where-Object {{ $c.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }}) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
        quote(&format!("{back}\\")),
        quote(&format!("{forward}/")),
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_processes_under(_dir: &Path) {}

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
    if http_ready(spec.port) {
        return take_pairing();
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

    {
        let mut started = services.0.lock().map_err(|e| e.to_string())?;
        let running = match started.get_mut(&id).and_then(|s| s.child.as_mut()) {
            Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        };
        // A tool that's already listening (started outside the shell, or still
        // warming up) only needs waiting for.
        if !running && !port_open(spec.port) {
            clean_up_leftovers(&spec);
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
        if http_ready(spec.port) {
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
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = command.status();
        }
    }
    if let Some(dir) = &spec.owned_dir {
        kill_processes_under(dir);
    }
}

/// Stop every tool this shell started, including their child processes.
pub fn stop_all(services: &Services) {
    let Ok(mut started) = services.0.lock() else {
        return;
    };
    let specs: Vec<Spec> = started.keys().filter_map(|id| spec(id).ok()).collect();
    for mut child in started.drain().filter_map(|(_, s)| s.child) {
        #[cfg(windows)]
        {
            // `.cmd` shims and Node spawn children; kill the whole tree.
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    for spec in &specs {
        clean_up_leftovers(spec);
    }
}
