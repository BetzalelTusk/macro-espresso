//! Updates from the build folder. New versions arrive as installers named
//! `Macro Espresso_<version>_arm64-setup.exe` in `Desktop\macro-desktop`, next
//! to `fix-macro-espresso.ps1`, which installs the newest one and refreshes the
//! tools. The app offers an installer newer than itself and runs that script.

use std::path::PathBuf;
use std::process::Command;

use tauri::AppHandle;

const INSTALLER_PREFIX: &str = "Macro Espresso_";
const INSTALLER_SUFFIX: &str = "_arm64-setup.exe";
const UPDATE_SCRIPT: &str = "fix-macro-espresso.ps1";

#[derive(serde::Serialize)]
pub struct Update {
    version: String,
}

fn updates_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .map(|home| PathBuf::from(home).join("Desktop").join("macro-desktop"))
        .ok_or_else(|| "USERPROFILE is not set".into())
}

/// "1.2.3" -> (1, 2, 3); anything else is not a version.
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.split('.').map(|p| p.parse::<u32>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

/// The newest installer in the build folder that is newer than this app.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Update>, String> {
    let current = app.package_info().version.to_string();
    let current = parse_version(&current).ok_or("This app's version is unreadable")?;
    let Ok(entries) = std::fs::read_dir(updates_dir()?) else {
        return Ok(None);
    };
    let newest = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter_map(|name| {
            let text = name.strip_prefix(INSTALLER_PREFIX)?.strip_suffix(INSTALLER_SUFFIX)?;
            Some((parse_version(text)?, text.to_owned()))
        })
        .max();
    Ok(newest
        .filter(|(version, _)| *version > current)
        .map(|(_, version)| Update { version }))
}

/// Run the update script in its own window (it shows its progress), then
/// quit so the script can replace the app. The script reopens it when done.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let script = updates_dir()?.join(UPDATE_SCRIPT);
    if !script.exists() {
        return Err(format!("The update script is missing: {}", script.display()));
    }
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    command
        .spawn()
        .map_err(|e| format!("Couldn't start the update: {e}"))?;
    // A clean quit stops the tools before the script copies over them.
    app.exit(0);
    Ok(())
}
