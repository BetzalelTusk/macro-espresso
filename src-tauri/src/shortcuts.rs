//! App keyboard shortcuts that work even while a tab's website has focus.
//!
//! A tab webview swallows key events, so the UI can't see them. These are
//! registered with the OS only while the shell's window is focused, and
//! released as soon as it isn't, so they never steal keys from other apps.

use tauri::{Emitter, Manager, Runtime, Window, WindowEvent, plugin::TauriPlugin};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

/// Every shortcut, with the name the UI receives in a `shortcut` event.
fn bindings() -> Vec<(Shortcut, &'static str)> {
    let ctrl = Some(Modifiers::CONTROL);
    let digits = [
        (Code::Digit1, "tab-1"),
        (Code::Digit2, "tab-2"),
        (Code::Digit3, "tab-3"),
        (Code::Digit4, "tab-4"),
        (Code::Digit5, "tab-5"),
        (Code::Digit6, "tab-6"),
        (Code::Digit7, "tab-7"),
        (Code::Digit8, "tab-8"),
        (Code::Digit9, "tab-9"),
    ];
    let mut all: Vec<_> = digits
        .into_iter()
        .map(|(code, name)| (Shortcut::new(ctrl, code), name))
        .collect();
    all.push((Shortcut::new(ctrl, Code::Tab), "next-tab"));
    all.push((
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Tab),
        "previous-tab",
    ));
    all.push((Shortcut::new(ctrl, Code::KeyK), "palette"));
    all.push((Shortcut::new(ctrl, Code::Backslash), "toggle-split"));
    all.push((Shortcut::new(ctrl, Code::KeyQ), "quit"));
    all
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((_, name)) = bindings().into_iter().find(|(s, _)| s == shortcut) {
                let _ = app.emit("shortcut", name);
            }
        })
        .build()
}

/// Hold the shortcuts only while `window` has focus.
pub fn bind_to_focus<R: Runtime>(window: &Window<R>) {
    let app = window.app_handle().clone();
    let register = move |focused: bool| {
        let shortcuts = app.global_shortcut();
        let _ = shortcuts.unregister_all();
        if focused {
            for (shortcut, _) in bindings() {
                let _ = shortcuts.register(shortcut);
            }
        }
    };
    register(true);
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            register(*focused);
        }
    });
}
