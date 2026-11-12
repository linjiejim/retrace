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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = core::State::load();
    let exiting = state.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state.clone())
        .manage(watch::Watcher::default())
        .setup(move |app| {
            watch::start_auto_fetch(app.handle().clone(), state.clone());
            relay_agent_events(app.handle().clone(), &state);
            core::shell_env::prefetch();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api, watch_project])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                let _ = window.emit("app-focused", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |_, event| {
            // Agents die with the app; the page has already asked before a normal quit.
            if let tauri::RunEvent::Exit = event {
                exiting.agents.stop_all();
            }
        });
}

/// Agent output and state changes, pushed to the page as events (the dev bridge polls instead).
fn relay_agent_events(app: tauri::AppHandle, state: &Arc<core::State>) {
    use base64::Engine;
    state.agents.set_notify(Arc::new(move |event| match event {
        core::agent::Event::Output { session, offset, data } => {
            let data = base64::engine::general_purpose::STANDARD.encode(data);
            let _ = app.emit("agent-output", serde_json::json!({ "session": session, "offset": offset, "data": data }));
        }
        core::agent::Event::Changed { session } => {
            let _ = app.emit("agent-changed", session);
        }
    }));
}
