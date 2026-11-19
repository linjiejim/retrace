pub mod core;
mod watch;

use std::sync::Arc;
use tauri::{Emitter, Manager};

/// The single command: forwards to `core::api::dispatch` on a blocking thread.
#[tauri::command]
async fn api(state: tauri::State<'_, Arc<core::State>>, cmd: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    let started = std::time::Instant::now();
    let name = cmd.clone();
    let result = tauri::async_runtime::spawn_blocking(move || core::api::dispatch(&st, &cmd, args))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"));
    if cfg!(debug_assertions) {
        eprintln!("[api] {name} {}ms {}", started.elapsed().as_millis(), result.as_ref().map(|_| "ok").unwrap_or_else(|e| e.as_str()));
    }
    result
}

/// Watch the selected project's git dir and worktrees; emits `repo-changed`.
#[tauri::command]
fn watch_project(app: tauri::AppHandle, watcher: tauri::State<'_, watch::Watcher>, id: Option<String>) -> Result<(), String> {
    watcher.watch(app, id).map_err(|e| format!("{e:#}"))
}

/// Brings the main window back (it may be hidden by closing it, or minimized) and to the front.
#[cfg(target_os = "macos")]
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = core::State::load();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state.clone())
        .manage(watch::Watcher::default())
        .setup(move |app| {
            watch::start_auto_fetch(app.handle().clone(), state.clone());
            // The menu bar icon (top right). Its menu, the project list, is built by the page (src/lib/menu.ts).
            tauri::tray::TrayIconBuilder::with_id("projects")
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)
                .tooltip("Retrace")
                .show_menu_on_left_click(true)
                .build(app)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api, watch_project])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                let _ = window.emit("app-focused", ());
            }
            // Closing the window only hides it: Retrace keeps running in the menu bar (and the Dock),
            // ready to come back. ⌘Q (Retrace > Quit, or the menu bar icon's Quit) still quits.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.is_fullscreen().unwrap_or(false) {
                    // Hidden in full screen, the window would leave its Space behind as a black
                    // screen: leave full screen first, and hide once the animation is over (tao
                    // reports no end of it).
                    let _ = window.set_fullscreen(false);
                    let window = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(900));
                        let _ = window.hide();
                    });
                } else {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Clicking the Dock icon with the window hidden brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                show_main(app);
            }
            let _ = (app, event);
        });
}
