mod services;

use std::sync::Mutex;

use tauri::{
    LogicalPosition, LogicalSize, Manager, Rect, State, WebviewBuilder, WebviewUrl, Window,
    window::WindowBuilder,
};

/// The webview that draws the shell's own UI (sidebar). Tab webviews sit on top
/// of its content area.
const UI_LABEL: &str = "ui";
const TAB_PREFIX: &str = "tab-";

/// Where tab webviews go, in logical pixels, as measured by the UI.
#[derive(Clone, Copy, serde::Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

#[derive(Default)]
struct Tabs {
    bounds: Option<Bounds>,
    active: Option<String>,
}

fn tab_label(id: &str) -> String {
    format!("{TAB_PREFIX}{id}")
}

/// Show tab `id`, creating its webview on first use, and hide every other tab.
#[tauri::command]
async fn open_tab(
    window: Window,
    tabs: State<'_, Mutex<Tabs>>,
    id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    tabs.bounds = Some(bounds);
    let label = tab_label(&id);

    for webview in window.webviews() {
        let other = webview.label();
        if other.starts_with(TAB_PREFIX) && other != label {
            webview.hide().map_err(|e| e.to_string())?;
        }
    }

    match window.get_webview(&label) {
        Some(webview) => {
            webview.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
            webview.show().map_err(|e| e.to_string())?;
            webview.set_focus().map_err(|e| e.to_string())?;
        }
        None => {
            eprintln!("[shell] creating {label} -> {url}");
            let url = url.parse().map_err(|e| format!("invalid url {url}: {e}"))?;
            let webview = window
                .add_child(
                    WebviewBuilder::new(&label, WebviewUrl::External(url)),
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                )
                .map_err(|e| e.to_string())?;
            eprintln!("[shell] created {label} at {:?}", webview.url());
        }
    }
    tabs.active = Some(id);
    Ok(())
}

/// Hide all tab webviews so the shell's own UI (e.g. a native Files view) shows.
#[tauri::command]
async fn hide_tabs(window: Window, tabs: State<'_, Mutex<Tabs>>) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    for webview in window.webviews() {
        if webview.label().starts_with(TAB_PREFIX) {
            webview.hide().map_err(|e| e.to_string())?;
        }
    }
    tabs.active = None;
    Ok(())
}

/// Move the active tab when the UI's content area changes size.
#[tauri::command]
async fn set_tab_bounds(
    window: Window,
    tabs: State<'_, Mutex<Tabs>>,
    bounds: Bounds,
) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    tabs.bounds = Some(bounds);
    if let Some(id) = &tabs.active {
        if let Some(webview) = window.get_webview(&tab_label(id)) {
            webview.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Reload a tab, or drop it so its next open starts fresh.
#[tauri::command]
async fn close_tab(window: Window, tabs: State<'_, Mutex<Tabs>>, id: String) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    if let Some(webview) = window.get_webview(&tab_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    if tabs.active.as_deref() == Some(id.as_str()) {
        tabs.active = None;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(Tabs::default()))
        .manage(services::Services::default())
        .setup(|app| {
            let width = 1280.0;
            let height = 800.0;
            let window = WindowBuilder::new(app, "main")
                .title("Shell")
                .inner_size(width, height)
                .min_inner_size(800.0, 500.0)
                .build()?;
            let ui = window.add_child(
                WebviewBuilder::new(UI_LABEL, WebviewUrl::App("index.html".into()))
                    .auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(width, height),
            )?;
            let _ = ui.set_focus();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_tab,
            hide_tabs,
            set_tab_bounds,
            close_tab,
            services::ensure_service
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                services::stop_all(&app.state::<services::Services>());
            }
        });
}
