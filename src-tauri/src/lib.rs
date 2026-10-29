mod services;
mod shortcuts;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, WebviewBuilder,
    WebviewUrl, Window,
    webview::PageLoadEvent,
    window::{Color, WindowBuilder},
};

/// The webview that draws the shell's own UI (rail, loading states). Tab
/// webviews sit on top of its content area.
const UI_LABEL: &str = "ui";
const TAB_PREFIX: &str = "tab-";

/// `--ground-0` in theme.css, so nothing flashes white before a page paints.
const GROUND: Color = Color(0x15, 0x19, 0x1c, 0xff);

/// Reveal a tab even if its page never reports a finished load.
const REVEAL_FALLBACK: Duration = Duration::from_secs(12);

/// A new tab loads off-screen at full size (so pages lay out correctly) and
/// moves into place once its first page load finishes.
const OFFSCREEN: f64 = -30_000.0;

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
    /// Tabs whose first page load finished (or timed out) and may be shown.
    revealed: HashSet<String>,
}

#[derive(Clone, serde::Serialize)]
struct TabReady<'a> {
    id: &'a str,
}

fn tab_label(id: &str) -> String {
    format!("{TAB_PREFIX}{id}")
}

/// Mark tab `id` loaded and, if it's the active tab, move it into place.
fn reveal(app: &AppHandle, id: &str) {
    let state = app.state::<Mutex<Tabs>>();
    let Ok(mut tabs) = state.lock() else {
        return;
    };
    if !tabs.revealed.insert(id.to_owned()) {
        return;
    }
    let Some(webview) = app
        .get_window("main")
        .and_then(|w| w.get_webview(&tab_label(id)))
    else {
        return;
    };
    match (tabs.active.as_deref() == Some(id), tabs.bounds) {
        (true, Some(bounds)) => {
            let _ = webview.set_bounds(bounds.rect());
            let _ = webview.show();
            let _ = webview.set_focus();
        }
        _ => {
            let _ = webview.hide();
        }
    }
    let _ = app.emit("tab-ready", TabReady { id });
}

/// Show tab `id`, creating its webview on first use, and hide every other tab.
/// Returns whether the tab is already loaded and visible.
#[tauri::command]
async fn open_tab(
    app: AppHandle,
    window: Window,
    tabs: State<'_, Mutex<Tabs>>,
    id: String,
    url: String,
    bounds: Bounds,
) -> Result<bool, String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    tabs.bounds = Some(bounds);
    tabs.active = Some(id.clone());
    let label = tab_label(&id);

    for webview in window.webviews() {
        let other = webview.label();
        if other.starts_with(TAB_PREFIX) && other != label {
            webview.hide().map_err(|e| e.to_string())?;
        }
    }

    if let Some(webview) = window.get_webview(&label) {
        if !tabs.revealed.contains(&id) {
            return Ok(false);
        }
        webview.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        webview.set_focus().map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let parsed = url.parse().map_err(|e| format!("invalid url {url}: {e}"))?;
    let loaded_id = id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .background_color(GROUND)
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                reveal(webview.app_handle(), &loaded_id);
            }
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(OFFSCREEN, OFFSCREEN),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;
    drop(tabs);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_FALLBACK).await;
        reveal(&app, &id);
    });
    Ok(false)
}

/// Hide all tab webviews so the shell's own UI (a native view, the command
/// palette) shows, and give it keyboard focus.
#[tauri::command]
async fn hide_tabs(window: Window, tabs: State<'_, Mutex<Tabs>>) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    for webview in window.webviews() {
        if webview.label().starts_with(TAB_PREFIX) {
            webview.hide().map_err(|e| e.to_string())?;
        }
    }
    if let Some(ui) = window.get_webview(UI_LABEL) {
        let _ = ui.set_focus();
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
    if let Some(id) = tabs.active.clone().filter(|id| tabs.revealed.contains(id)) {
        if let Some(webview) = window.get_webview(&tab_label(&id)) {
            webview.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Drop a tab's webview so its next open starts fresh.
#[tauri::command]
async fn close_tab(window: Window, tabs: State<'_, Mutex<Tabs>>, id: String) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    if let Some(webview) = window.get_webview(&tab_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    tabs.revealed.remove(&id);
    if tabs.active.as_deref() == Some(id.as_str()) {
        tabs.active = None;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(shortcuts::plugin())
        .manage(Mutex::new(Tabs::default()))
        .manage(services::Services::default())
        .setup(|app| {
            let width = 1280.0;
            let height = 800.0;
            let window = WindowBuilder::new(app, "main")
                .title("Shell")
                .inner_size(width, height)
                .min_inner_size(800.0, 500.0)
                .theme(Some(tauri::Theme::Dark))
                .background_color(GROUND)
                .build()?;
            let ui = window.add_child(
                WebviewBuilder::new(UI_LABEL, WebviewUrl::App("index.html".into()))
                    .background_color(GROUND)
                    .auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(width, height),
            )?;
            let _ = ui.set_focus();
            shortcuts::bind_to_focus(&window);
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
