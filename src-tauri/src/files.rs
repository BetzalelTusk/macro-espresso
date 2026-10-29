//! The Files tab's view of the local disk: places, folder listings, and
//! handing files to their default apps. Only the shell's own UI can call
//! these (tab webviews have no IPC; see capabilities/default.json).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
pub struct Place {
    name: String,
    path: String,
    /// "home", "desktop", "documents", "downloads", "pictures", "music",
    /// "videos" or "drive": the UI picks an icon from it.
    kind: &'static str,
}

#[derive(serde::Serialize)]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
    /// Bytes; 0 for folders.
    size: u64,
    /// Milliseconds since the Unix epoch, when known.
    modified: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct Listing {
    path: String,
    /// The folder above, unless this is a drive root.
    parent: Option<String>,
    entries: Vec<Entry>,
    /// Hidden and system items left out of `entries`.
    hidden: usize,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The user's standard folders that exist, then every mounted drive.
#[tauri::command]
pub fn fs_places() -> Vec<Place> {
    let mut places = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        places.push(Place { name: "Home".into(), path: display(&home), kind: "home" });
        for (name, kind) in [
            ("Desktop", "desktop"),
            ("Documents", "documents"),
            ("Downloads", "downloads"),
            ("Pictures", "pictures"),
            ("Music", "music"),
            ("Videos", "videos"),
        ] {
            let path = home.join(name);
            if path.is_dir() {
                places.push(Place { name: name.into(), path: display(&path), kind });
            }
        }
    }
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).exists() {
            places.push(Place { name: format!("{}:", letter as char), path: root, kind: "drive" });
        }
    }
    places
}

#[cfg(windows)]
fn is_hidden(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    metadata.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn list(path: &Path, show_hidden: bool) -> Result<Listing, String> {
    let read = std::fs::read_dir(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "You don't have permission to open this folder.".to_owned(),
        std::io::ErrorKind::NotFound => "This folder doesn't exist anymore.".to_owned(),
        _ => format!("Couldn't open this folder: {e}"),
    })?;
    let mut entries = Vec::new();
    let mut hidden = 0;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // Follow symlinks for type and size; fall back to the link itself.
        let Ok(metadata) = std::fs::metadata(item.path()).or_else(|_| item.metadata()) else {
            continue;
        };
        if !show_hidden && (is_hidden(&metadata) || name.starts_with('.')) {
            hidden += 1;
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        entries.push(Entry {
            name,
            path: display(&item.path()),
            dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            modified,
        });
    }
    Ok(Listing {
        path: display(path),
        parent: path.parent().map(display),
        entries,
        hidden,
    })
}

/// List a folder. Runs off the main thread: big folders and slow drives
/// mustn't freeze the window.
#[tauri::command]
pub async fn fs_list(path: String, show_hidden: bool) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || list(Path::new(&path), show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

/// Open a file (or folder) with its default app.
#[tauri::command]
pub fn fs_open(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Show an item selected in File Explorer.
#[tauri::command]
pub fn fs_reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}
