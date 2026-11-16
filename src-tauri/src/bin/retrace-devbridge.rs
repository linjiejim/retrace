//! Development only: serves `core::api::dispatch` over HTTP on 127.0.0.1:5198 so the UI can be
//! worked on in a normal browser (`pnpm dev`, Vite proxies `/api`). Not part of the app bundle.
//!
//! Requests must carry `X-Retrace: 1`; browsers can't add that header cross-site without a
//! preflight, which this server never approves. They must also name this machine (Host, and
//! Origin when there is one): a page whose own name was pointed at 127.0.0.1 is same-origin to
//! the bridge, but still says its name. Agent sessions answer only with
//! `RETRACE_DEVBRIDGE_AGENTS=1`.

use tiny_http::{Header, Method, Response, Server};

fn main() {
    let state = retrace_lib::core::State::load();
    // Agents start processes; the bridge runs them only when asked to (for working on their UI).
    let agents = std::env::var("RETRACE_DEVBRIDGE_AGENTS").is_ok_and(|v| v == "1");
    state.agents_allowed.store(agents, std::sync::atomic::Ordering::Relaxed);
    retrace_lib::core::api::reattach_background(state.clone());
    let server = Server::http("127.0.0.1:5198").expect("port 5198 is busy");
    eprintln!("retrace-devbridge listening on http://127.0.0.1:5198 (config: {}, agents: {})", state.config_path.display(), if agents { "on" } else { "off" });
    for mut request in server.incoming_requests() {
        let state = state.clone();
        std::thread::spawn(move || {
            let json = Header::from_bytes("Content-Type", "application/json").unwrap();
            let header = |name: &'static str| request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string());
            let from_here = header("Host").is_some_and(|h| local(&h)) && header("Origin").is_none_or(|o| o.split_once("://").is_some_and(|(_, at)| local(at)));
            let allowed = request.method() == &Method::Post && header("X-Retrace").as_deref() == Some("1") && from_here;
            let Some(cmd) = request.url().strip_prefix("/api/").map(str::to_string).filter(|_| allowed) else {
                let _ = request.respond(Response::from_string("forbidden").with_status_code(403));
                return;
            };
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let args = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
            let (status, payload) = match retrace_lib::core::api::dispatch(&state, &cmd, args) {
                Ok(v) => (200, serde_json::json!({ "ok": v })),
                Err(e) => (200, serde_json::json!({ "error": format!("{e:#}") })),
            };
            let _ = request.respond(Response::from_string(payload.to_string()).with_status_code(status).with_header(json));
        });
    }
}

/// This machine by name (`localhost`, `127.0.0.1`, `[::1]`), with or without a port.
fn local(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}
