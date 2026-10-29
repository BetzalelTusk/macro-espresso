mod files;
mod services;
mod shortcuts;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, WebviewBuilder,
    WebviewUrl, Window, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PageLoadEvent},
    window::{Color, WindowBuilder},
};

/// The webview that draws the shell's own UI (rail, panes, stage). Tab
/// webviews sit on top of its pane areas.
const UI_LABEL: &str = "ui";
const TAB_PREFIX: &str = "tab-";

/// `--ground-0` in theme.css (oklch 0.165 0.008 235 → #0b0f11), so nothing
/// flashes a different colour before a page paints.
const GROUND: Color = Color(0x0b, 0x0f, 0x11, 0xff);

/// Title bar colours as Windows COLORREFs (0x00BBGGRR): caption `--ground-1`
/// (#13181b, continuing the rail), text `--ink-2` (#acb2b5), border `--line`
/// (#31363a).
#[cfg(windows)]
const TITLE_BAR: [(u32, u32); 3] = [(35, 0x001b_1813), (36, 0x00b5_b2ac), (34, 0x003a_3631)];

/// Paint the native title bar in the shell's colours (Windows 11; older
/// versions ignore these attributes and keep the dark title bar).
#[cfg(windows)]
fn tint_title_bar(window: &Window) {
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const u32, size: u32) -> i32;
    }
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    for (attribute, colour) in TITLE_BAR {
        // DWMWA_BORDER_COLOR (34), DWMWA_CAPTION_COLOR (35), DWMWA_TEXT_COLOR (36).
        unsafe {
            DwmSetWindowAttribute(hwnd.0 as isize, attribute, &colour, size_of::<u32>() as u32);
        }
    }
}

#[cfg(not(windows))]
fn tint_title_bar(_window: &Window) {}

/// Where each web tab was, saved on hide-to-tray and quit, so a restart
/// reopens the same page (an album, a document) instead of the home page.
fn tab_pages_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("tab-pages.json"))
}

fn load_tab_pages(app: &AppHandle) -> HashMap<String, String> {
    tab_pages_file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_tab_pages(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let mut pages = load_tab_pages(app);
    for webview in window.webviews() {
        let Some(id) = webview.label().strip_prefix(TAB_PREFIX) else {
            continue;
        };
        if let Ok(url) = webview.url() {
            // Local tools sign in through one-time URLs; never replay those.
            if url.scheme() == "https" {
                pages.insert(id.to_owned(), url.to_string());
            }
        }
    }
    if let (Some(path), Ok(text)) = (tab_pages_file(app), serde_json::to_string_pretty(&pages)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, text);
    }
}

/// The page to open for a new tab: its saved page if it's on the same site.
fn restored_url(app: &AppHandle, id: &str, default: tauri::Url) -> tauri::Url {
    load_tab_pages(app)
        .get(id)
        .and_then(|saved| saved.parse::<tauri::Url>().ok())
        .filter(|saved| saved.origin() == default.origin() && default.scheme() == "https")
        .unwrap_or(default)
}

/// Reveal a tab even if its page never reports a finished load.
const REVEAL_FALLBACK: Duration = Duration::from_secs(12);

/// A new tab loads off-screen at full size (so pages lay out correctly) and
/// moves into place once its first page load finishes.
const OFFSCREEN: f64 = -30_000.0;

/// Where a tab webview goes, in logical pixels, as measured by the UI.
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

fn full_size() -> f64 {
    1.0
}

/// Where a tab goes and how far its page is zoomed (below 1 when the pane is
/// narrower than the site's minimum layout width).
#[derive(Clone, Copy, serde::Deserialize)]
struct Place {
    bounds: Bounds,
    #[serde(default = "full_size")]
    zoom: f64,
}

impl Place {
    /// Move the tab and set its zoom. Zoom is only sent when it changes: a
    /// zoom call makes pages re-layout, which flickers on every resize.
    fn apply<R: tauri::Runtime>(
        self,
        webview: &tauri::Webview<R>,
        zooms: &mut HashMap<String, f64>,
        id: &str,
    ) -> tauri::Result<()> {
        webview.set_bounds(self.bounds.rect())?;
        let applied = zooms.get(id).copied().unwrap_or(1.0);
        if (applied - self.zoom).abs() > f64::EPSILON {
            webview.set_zoom(self.zoom)?;
            zooms.insert(id.to_owned(), self.zoom);
        }
        Ok(())
    }
}

/// One tab the UI wants on screen.
#[derive(serde::Deserialize)]
struct View {
    id: String,
    url: String,
    #[serde(flatten)]
    place: Place,
}

#[derive(serde::Deserialize)]
struct Placement {
    id: String,
    #[serde(flatten)]
    place: Place,
}

#[derive(Default)]
struct Tabs {
    /// The tabs on screen right now (one, or two in a split), and where.
    visible: HashMap<String, Place>,
    /// Tabs whose first page load finished (or timed out) and may be shown.
    revealed: HashSet<String>,
    /// The tab that should hold keyboard focus once it's revealed.
    focus: Option<String>,
    /// The zoom each tab's webview currently has.
    zooms: HashMap<String, f64>,
}

#[derive(Clone, serde::Serialize)]
struct TabReady<'a> {
    id: &'a str,
}

fn tab_label(id: &str) -> String {
    format!("{TAB_PREFIX}{id}")
}

/// Let a tab show notifications. WebView2 denies permission requests the host
/// doesn't answer, and stores that "deny" in the profile, so WhatsApp and the
/// others could never notify. The tab's origin is set to "allow" in the
/// profile, and later requests are answered "allow". Only the notification
/// permission is granted; camera, mic and the rest keep the default behaviour.
#[cfg(windows)]
fn allow_notifications<R: tauri::Runtime>(webview: &tauri::Webview<R>, origin: String) {
    let _ = webview.with_webview(move |platform| unsafe {
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler,
            SetPermissionStateCompletedHandler,
        };
        use windows_core::{HSTRING, Interface};
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let set_profile = || -> windows_core::Result<()> {
            let profile: ICoreWebView2Profile4 = core.cast::<ICoreWebView2_13>()?.Profile()?.cast()?;
            profile.SetPermissionState(
                COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
                &HSTRING::from(origin.as_str()),
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                &SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(()))),
            )
        };
        let _ = set_profile();
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

#[cfg(not(windows))]
fn allow_notifications<R: tauri::Runtime>(_webview: &tauri::Webview<R>, _origin: String) {}

fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window("main")
}

/// Mark tab `id` loaded and, if it's on screen, move it into place.
fn reveal(app: &AppHandle, id: &str) {
    let state = app.state::<Mutex<Tabs>>();
    let Ok(mut tabs) = state.lock() else {
        return;
    };
    if !tabs.revealed.insert(id.to_owned()) {
        return;
    }
    let Some(webview) = main_window(app).and_then(|w| w.get_webview(&tab_label(id))) else {
        return;
    };
    match tabs.visible.get(id).copied() {
        Some(place) => {
            let _ = place.apply(&webview, &mut tabs.zooms, id);
            let _ = webview.show();
            if tabs.focus.as_deref() == Some(id) {
                let _ = webview.set_focus();
            }
        }
        None => {
            let _ = webview.hide();
        }
    }
    let _ = app.emit("tab-ready", TabReady { id });
}

/// Put exactly `views` on screen, creating webviews on first use, and hide
/// every other tab. Returns the ids that are loaded and showing now; the rest
/// report `tab-ready` when their first page load finishes.
#[tauri::command]
async fn show_tabs(
    app: AppHandle,
    window: Window,
    tabs: State<'_, Mutex<Tabs>>,
    views: Vec<View>,
    focus: Option<String>,
) -> Result<Vec<String>, String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    tabs.visible = views.iter().map(|v| (v.id.clone(), v.place)).collect();
    tabs.focus = focus.clone();

    for webview in window.webviews() {
        let label = webview.label();
        if let Some(id) = label.strip_prefix(TAB_PREFIX) {
            if !tabs.visible.contains_key(id) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
    }

    let mut showing = Vec::new();
    for view in views {
        let label = tab_label(&view.id);
        if let Some(webview) = window.get_webview(&label) {
            if tabs.revealed.contains(&view.id) {
                view.place
                    .apply(&webview, &mut tabs.zooms, &view.id)
                    .map_err(|e| e.to_string())?;
                webview.show().map_err(|e| e.to_string())?;
                if focus.as_deref() == Some(view.id.as_str()) {
                    webview.set_focus().map_err(|e| e.to_string())?;
                }
                showing.push(view.id);
            }
            continue;
        }

        let parsed: tauri::Url = view
            .url
            .parse()
            .map_err(|e| format!("invalid url {}: {e}", view.url))?;
        let origin = parsed.origin().ascii_serialization();
        let parsed = restored_url(&app, &view.id, parsed);
        let loaded_id = view.id.clone();
        let opener = app.clone();
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
            .background_color(GROUND)
            .on_page_load(move |webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    reveal(webview.app_handle(), &loaded_id);
                }
            })
            .on_new_window(move |url, features| {
                // A sized popup is a sign-in flow (window.open with a size):
                // keep it, it reports back to the page. A plain new-tab link
                // goes to the default browser instead of a bare window.
                if features.size().is_some() {
                    return NewWindowResponse::Allow;
                }
                use tauri_plugin_opener::OpenerExt;
                if matches!(url.scheme(), "http" | "https" | "mailto") {
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                }
                NewWindowResponse::Deny
            });
        window
            .add_child(
                builder,
                LogicalPosition::new(OFFSCREEN, OFFSCREEN),
                LogicalSize::new(view.place.bounds.width, view.place.bounds.height),
            )
            .and_then(|webview| {
                // Zoom before the first load so the page lays out at its size.
                webview.set_zoom(view.place.zoom)?;
                allow_notifications(&webview, origin);
                Ok(webview)
            })
            .map_err(|e| e.to_string())?;
        tabs.zooms.insert(view.id.clone(), view.place.zoom);
        let app = app.clone();
        let id = view.id;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(REVEAL_FALLBACK).await;
            reveal(&app, &id);
        });
    }
    Ok(showing)
}

/// Hide all tab webviews so the shell's own UI (the command palette) shows,
/// and give it keyboard focus.
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
    tabs.visible.clear();
    Ok(())
}

/// Move the on-screen tabs when the panes change size.
#[tauri::command]
async fn set_tab_bounds(
    window: Window,
    tabs: State<'_, Mutex<Tabs>>,
    placements: Vec<Placement>,
) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    for placement in placements {
        if !tabs.visible.contains_key(&placement.id) {
            continue;
        }
        tabs.visible.insert(placement.id.clone(), placement.place);
        if tabs.revealed.contains(&placement.id) {
            if let Some(webview) = window.get_webview(&tab_label(&placement.id)) {
                placement
                    .place
                    .apply(&webview, &mut tabs.zooms, &placement.id)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Drop a tab's webview so its next show starts fresh.
#[tauri::command]
async fn close_tab(window: Window, tabs: State<'_, Mutex<Tabs>>, id: String) -> Result<(), String> {
    let mut tabs = tabs.lock().map_err(|e| e.to_string())?;
    if let Some(webview) = window.get_webview(&tab_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    tabs.revealed.remove(&id);
    tabs.visible.remove(&id);
    tabs.zooms.remove(&id);
    Ok(())
}

/// Quit for real (closing the window only hides it to the tray).
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn show_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Shell", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Shell", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("shell")
        .tooltip("Shell")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second launch focuses the running shell instead of starting
        // another one, which would fight over the tools' ports.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
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

            // Closing the window keeps tabs (and their notifications) alive in
            // the tray; Quit in the tray or palette ends the app.
            let hide = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    save_tab_pages(hide.app_handle());
                    let _ = hide.hide();
                }
            });
            tint_title_bar(&window);
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_tabs,
            hide_tabs,
            set_tab_bounds,
            close_tab,
            quit,
            services::ensure_service,
            services::restart_service,
            services::reveal_log,
            files::fs_places,
            files::fs_list,
            files::fs_open,
            files::fs_reveal
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Tab webviews are still alive here, so their pages can be saved.
            tauri::RunEvent::ExitRequested { .. } => save_tab_pages(app),
            tauri::RunEvent::Exit => services::stop_all(&app.state::<services::Services>()),
            _ => {}
        });
}
