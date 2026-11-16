//! Background sessions end to end: conversations that run on OpenCode's own server, so they go on
//! while Retrace is gone and are picked up again. A small in-process HTTP server plays OpenCode's
//! (`opencode serve`): its routes, its event stream, a turn chosen by a word in the message.

use retrace_lib::core::acp::Open;
use retrace_lib::core::agent::{self, LiveState, Meta};
use retrace_lib::core::api::{dispatch, reattach_background};
use retrace_lib::core::opencode_server::{Endpoint, Host};
use retrace_lib::core::shell_env::Env;
use retrace_lib::core::State;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(name: &str) -> TempDir {
    let base = std::env::temp_dir().join(format!("retrace-bg-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    TempDir(std::fs::canonicalize(&base).unwrap())
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let started = Instant::now();
    while !ok() {
        assert!(started.elapsed() < Duration::from_secs(15), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(30));
    }
}

// ---------- a stand-in OpenCode server ----------

#[derive(Default)]
struct Conversation {
    dir: String,
    messages: Vec<Value>,
    busy: bool,
    /// The mode (OpenCode's agent) of the last message, and the last message's body as sent.
    agent: Option<String>,
    last_prompt: Value,
}

#[derive(Default)]
struct World {
    sessions: Vec<(String, Conversation)>,
    /// Permission id → (session, whether it was answered and how).
    asks: Vec<(String, String, Option<String>)>,
    streams: Vec<Sender<Vec<u8>>>,
    aborted: Vec<String>,
    /// How many times a turn was stopped.
    aborts: usize,
    /// Reading one conversation fails (500), and the health check takes longer than Retrace waits.
    broken_get: bool,
    slow_health: bool,
}

struct Fake {
    url: String,
    password: String,
    world: Arc<Mutex<World>>,
    next: Arc<AtomicU64>,
    down: Arc<AtomicBool>,
}

struct Stream(Receiver<Vec<u8>>, Vec<u8>, Arc<AtomicBool>);
impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.1.is_empty() {
            if self.2.load(Ordering::Relaxed) {
                return Ok(0);
            }
            match self.0.recv_timeout(Duration::from_millis(100)) {
                Ok(b) => self.1 = b,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.1.len());
        buf[..n].copy_from_slice(&self.1[..n]);
        self.1.drain(..n);
        Ok(n)
    }
}

impl Fake {
    fn start() -> Fake {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let url = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        let fake = Fake { url, password: "pw".into(), world: Default::default(), next: Arc::new(AtomicU64::new(1)), down: Default::default() };
        let (world, next, down) = (fake.world.clone(), fake.next.clone(), fake.down.clone());
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                if down.load(Ordering::Relaxed) {
                    let _ = req.respond(tiny_http::Response::from_string("gone").with_status_code(503));
                    continue;
                }
                let (world, next, down) = (world.clone(), next.clone(), down.clone());
                std::thread::spawn(move || handle(req, world, next, down));
            }
        });
        fake
    }

    fn host(&self) -> Arc<Host> {
        Arc::new(Host::attached(Endpoint::new(&self.url, &self.password, None)))
    }
}

fn emit(world: &Mutex<World>, kind: &str, props: Value) {
    let line = format!("data: {}\n\n", json!({ "type": kind, "properties": props }));
    let mut w = world.lock().unwrap();
    w.streams.retain(|s| s.send(line.clone().into_bytes()).is_ok());
}

fn id(next: &AtomicU64, prefix: &str) -> String {
    format!("{prefix}_{:06}", next.fetch_add(1, Ordering::Relaxed))
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix(&format!("{key}="))).map(|v| v.replace("%20", " "))
}

/// Add or replace a message part, and say so on the stream.
fn put(world: &Mutex<World>, sid: &str, msg: &Value, part: Value) {
    {
        let mut w = world.lock().unwrap();
        let conv = &mut w.sessions.iter_mut().find(|(i, _)| i == sid).unwrap().1;
        let mid = msg["info"]["id"].as_str().unwrap();
        if let Some(m) = conv.messages.iter_mut().find(|m| m["info"]["id"] == mid) {
            let parts = m["parts"].as_array_mut().unwrap();
            match parts.iter_mut().find(|p| p["id"] == part["id"]) {
                Some(p) => *p = part.clone(),
                None => parts.push(part.clone()),
            }
        } else {
            let mut m = msg.clone();
            m["parts"] = json!([part.clone()]);
            conv.messages.push(m);
        }
    }
    emit(world, "message.part.updated", json!({ "sessionID": sid, "part": part }));
}

fn set_info(world: &Mutex<World>, sid: &str, info: Value) {
    {
        let mut w = world.lock().unwrap();
        let conv = &mut w.sessions.iter_mut().find(|(i, _)| i == sid).unwrap().1;
        match conv.messages.iter_mut().find(|m| m["info"]["id"] == info["id"]) {
            Some(m) => m["info"] = info.clone(),
            None => conv.messages.push(json!({ "info": info.clone(), "parts": [] })),
        }
    }
    emit(world, "message.updated", json!({ "sessionID": sid, "info": info }));
}

fn set_busy(world: &Mutex<World>, sid: &str, busy: bool) {
    world.lock().unwrap().sessions.iter_mut().find(|(i, _)| i == sid).unwrap().1.busy = busy;
    emit(world, "session.status", json!({ "sessionID": sid, "status": { "type": if busy { "busy" } else { "idle" } } }));
    if !busy {
        emit(world, "session.idle", json!({ "sessionID": sid }));
    }
}

fn aborted(world: &Mutex<World>, sid: &str) -> bool {
    world.lock().unwrap().aborted.iter().any(|a| a == sid)
}

/// One turn, chosen by a word in the message.
fn turn(world: Arc<Mutex<World>>, next: Arc<AtomicU64>, sid: String, text: String, model: Value) {
    let uid = id(&next, "msg");
    set_info(&world, &sid, json!({ "id": uid, "role": "user", "sessionID": sid }));
    put(&world, &sid, &json!({ "info": { "id": uid } }), json!({ "id": id(&next, "prt"), "messageID": uid, "sessionID": sid, "type": "text", "text": text }));
    if text.contains("LATE") {
        // The message is in, the turn not started yet (OpenCode answers prompt_async first).
        std::thread::sleep(Duration::from_millis(400));
    }
    set_busy(&world, &sid, true);
    let aid = id(&next, "msg");
    let mut info = json!({ "id": aid, "role": "assistant", "parentID": uid, "sessionID": sid, "providerID": model["providerID"], "modelID": model["modelID"] });
    set_info(&world, &sid, info.clone());
    let msg = json!({ "info": { "id": aid } });
    let say = |t: &str| put(&world, &sid, &msg, json!({ "id": id(&next, "prt"), "messageID": aid, "sessionID": sid, "type": "text", "text": t }));
    if text.contains("HUGE") {
        // An answer longer than ureq reads into a string (10 MB).
        say(&"x".repeat(11 << 20));
        set_info(&world, &sid, json!({ "id": aid, "role": "assistant", "parentID": uid, "sessionID": sid, "finish": "stop" }));
        set_busy(&world, &sid, false);
        return;
    }
    if text.contains("BROKE") {
        emit(&world, "session.error", json!({ "sessionID": sid, "error": { "name": "APIError", "data": { "message": "insufficient balance (1008)" } } }));
        info["error"] = json!({ "name": "APIError", "data": { "message": "insufficient balance (1008)" } });
        set_info(&world, &sid, info.clone());
    } else if text.contains("PLEASE-ASK") {
        let tool = json!({ "id": id(&next, "prt"), "messageID": aid, "sessionID": sid, "type": "tool", "tool": "bash", "callID": "c1", "state": { "status": "running", "input": { "command": "rm -rf build" } } });
        put(&world, &sid, &msg, tool.clone());
        let per = id(&next, "per");
        world.lock().unwrap().asks.push((per.clone(), sid.clone(), None));
        emit(&world, "permission.asked", json!({ "id": per, "sessionID": sid, "permission": "bash", "patterns": ["rm -rf build"], "metadata": { "command": "rm -rf build" }, "tool": { "messageID": aid, "callID": "c1" } }));
        let reply = loop {
            if aborted(&world, &sid) {
                break None;
            }
            if let Some(r) = world.lock().unwrap().asks.iter().find(|a| a.0 == per).and_then(|a| a.2.clone()) {
                break Some(r);
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        match reply.as_deref() {
            Some("reject") => {
                put(&world, &sid, &msg, json!({ "id": tool["id"], "messageID": aid, "sessionID": sid, "type": "tool", "tool": "bash", "callID": "c1", "state": { "status": "error", "input": { "command": "rm -rf build" }, "error": "rejected" } }));
                say("Left it alone.");
            }
            Some(_) => {
                put(&world, &sid, &msg, json!({ "id": tool["id"], "messageID": aid, "sessionID": sid, "type": "tool", "tool": "bash", "callID": "c1", "state": { "status": "completed", "input": { "command": "rm -rf build" }, "output": "removed\n", "title": "rm -rf build" } }));
                say("Removed it.");
            }
            None => {
                info["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "Aborted" } });
                set_info(&world, &sid, info.clone());
            }
        }
    } else if text.contains("SLOW") {
        // Long enough for Retrace to let go and come back.
        let until = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < until && !aborted(&world, &sid) {
            std::thread::sleep(Duration::from_millis(20));
        }
        if aborted(&world, &sid) {
            info["error"] = json!({ "name": "MessageAbortedError", "data": { "message": "Aborted" } });
            set_info(&world, &sid, info.clone());
        } else {
            say("Done slowly.");
        }
    } else {
        put(&world, &sid, &msg, json!({ "id": id(&next, "prt"), "messageID": aid, "sessionID": sid, "type": "reasoning", "text": "Look first." }));
        let dir = world.lock().unwrap().sessions.iter().find(|(i, _)| *i == sid).unwrap().1.dir.clone();
        put(&world, &sid, &msg, json!({ "id": id(&next, "prt"), "messageID": aid, "sessionID": sid, "type": "tool", "tool": "edit", "callID": "c0",
            "state": { "status": "completed", "title": "cart.js", "input": { "filePath": format!("{dir}/cart.js"), "oldString": "a", "newString": "a\nb" }, "output": "Edit applied successfully.",
                       "metadata": { "filediff": { "file": format!("{dir}/cart.js"), "additions": 1, "deletions": 0 } } } }));
        let pid = id(&next, "prt");
        put(&world, &sid, &msg, json!({ "id": pid, "messageID": aid, "sessionID": sid, "type": "text", "text": "" }));
        for d in ["Added ", "`square`."] {
            emit(&world, "message.part.delta", json!({ "sessionID": sid, "messageID": aid, "partID": pid, "field": "text", "delta": d }));
        }
        put(&world, &sid, &msg, json!({ "id": pid, "messageID": aid, "sessionID": sid, "type": "text", "text": "Added `square`." }));
        info["tokens"] = json!({ "input": 1000, "output": 200, "reasoning": 0, "cache": { "read": 0, "write": 0 } });
    }
    if !aborted(&world, &sid) {
        info["finish"] = json!("stop");
        set_info(&world, &sid, info);
    }
    world.lock().unwrap().aborted.retain(|a| *a != sid);
    emit(&world, "session.updated", json!({ "sessionID": sid, "info": { "id": sid, "title": "Add square", "model": { "providerID": model["providerID"], "id": model["modelID"] } } }));
    set_busy(&world, &sid, false);
}

fn handle(mut req: tiny_http::Request, world: Arc<Mutex<World>>, next: Arc<AtomicU64>, down: Arc<AtomicBool>) {
    use tiny_http::{Header, Response};
    let authed = req.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == "Basic b3BlbmNvZGU6cHc=");
    if !authed {
        let _ = req.respond(Response::from_string("unauthorized").with_status_code(401));
        return;
    }
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let method = req.method().to_string();
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let dir = query(&url, "directory").unwrap_or_default();
    let ok = |v: Value| Response::from_string(v.to_string()).with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let reply = match (method.as_str(), parts.as_slice()) {
        ("GET", ["global", "health"]) => {
            if world.lock().unwrap().slow_health {
                std::thread::sleep(Duration::from_secs(4));
            }
            ok(json!({ "healthy": true, "version": "1.19.5" }))
        }
        ("GET", ["event"]) => {
            let (tx, rx) = channel();
            let _ = tx.send(b"data: {\"type\":\"server.connected\",\"properties\":{}}\n\n".to_vec());
            world.lock().unwrap().streams.push(tx);
            // Written by hand, each event flushed at once (tiny_http's own responses buffer 8 KB).
            let mut stream = Stream(rx, Vec::new(), down);
            let mut out = req.into_writer();
            let _ = out.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
            let _ = out.flush();
            let mut buf = [0u8; 8192];
            while let Ok(n) = stream.read(&mut buf) {
                // The end of the stream is the end of the body: the client sees the server go.
                let chunk = if n == 0 { b"0\r\n\r\n".to_vec() } else { [format!("{n:x}\r\n").into_bytes(), buf[..n].to_vec(), b"\r\n".to_vec()].concat() };
                if out.write_all(&chunk).and_then(|_| out.flush()).is_err() || n == 0 {
                    break;
                }
            }
            return;
        }
        ("POST", ["session"]) => {
            let sid = id(&next, "ses");
            world.lock().unwrap().sessions.push((sid.clone(), Conversation { dir: dir.clone(), ..Default::default() }));
            ok(json!({ "id": sid, "directory": dir, "title": "New session - x" }))
        }
        ("GET", ["session"]) => ok(Value::Array(world.lock().unwrap().sessions.iter().map(|(i, c)| json!({ "id": i, "directory": c.dir, "time": { "updated": 1 } })).collect())),
        ("GET", ["session", "status"]) => {
            let w = world.lock().unwrap();
            let mut out = serde_json::Map::new();
            for (i, c) in &w.sessions {
                if c.busy {
                    out.insert(i.clone(), json!({ "type": "busy" }));
                }
            }
            ok(Value::Object(out))
        }
        ("GET", ["session", _]) if world.lock().unwrap().broken_get => Response::from_string(json!({ "name": "UnknownError", "data": { "message": "storage busy" } }).to_string()).with_status_code(500),
        ("GET", ["session", sid]) => match world.lock().unwrap().sessions.iter().find(|(i, _)| i == sid) {
            Some((i, c)) => ok(json!({ "id": i, "directory": c.dir, "title": "Add square", "agent": c.agent })),
            None => Response::from_string(json!({ "name": "NotFoundError", "data": { "message": "Session not found" } }).to_string()).with_status_code(404),
        },
        ("GET", ["session", sid, "message"]) => ok(Value::Array(world.lock().unwrap().sessions.iter().find(|(i, _)| i == sid).map(|(_, c)| c.messages.clone()).unwrap_or_default())),
        ("POST", ["session", sid, "prompt_async"]) => {
            let text = body["parts"][0]["text"].as_str().unwrap_or("").to_string();
            let (world, next, sid) = (world.clone(), next.clone(), sid.to_string());
            let model = body["model"].clone();
            {
                let mut w = world.lock().unwrap();
                let conv = &mut w.sessions.iter_mut().find(|(i, _)| *i == sid).unwrap().1;
                conv.agent = body["agent"].as_str().map(str::to_string);
                conv.last_prompt = body.clone();
            }
            std::thread::spawn(move || turn(world, next, sid, text, model));
            Response::from_string("").with_status_code(204)
        }
        ("POST", ["session", sid, "abort"]) => {
            let mut w = world.lock().unwrap();
            // Like OpenCode: stops a turn in progress, does nothing to one not started yet.
            if w.sessions.iter().any(|(i, c)| i == sid && c.busy) {
                w.aborted.push(sid.to_string());
            }
            w.aborts += 1;
            ok(json!(true))
        }
        ("GET", ["permission"]) => ok(Value::Array(world.lock().unwrap().asks.iter().filter(|a| a.2.is_none()).map(|(i, s, _)| json!({ "id": i, "sessionID": s, "permission": "bash", "patterns": ["rm -rf build"], "metadata": { "command": "rm -rf build" }, "tool": { "callID": "c1" } })).collect())),
        ("POST", ["permission", per, "reply"]) => {
            let reply = body["reply"].as_str().unwrap_or("").to_string();
            let sid = {
                let mut w = world.lock().unwrap();
                let a = w.asks.iter_mut().find(|a| a.0 == *per).unwrap();
                a.2 = Some(reply.clone());
                a.1.clone()
            };
            emit(&world, "permission.replied", json!({ "sessionID": sid, "requestID": per, "reply": reply }));
            ok(json!(true))
        }
        ("GET", ["config", "providers"]) => ok(json!({ "default": { "opencode": "big-pickle" }, "providers": [
            { "id": "opencode", "name": "OpenCode", "models": { "big-pickle": { "id": "big-pickle", "name": "Big Pickle", "limit": { "context": 200000 } }, "beam": { "id": "beam", "name": "Beam", "limit": { "context": 100000 } } } }
        ] })),
        ("GET", ["agent"]) => ok(json!([{ "name": "build", "mode": "primary" }, { "name": "plan", "mode": "primary" }, { "name": "explore", "mode": "subagent" }, { "name": "title", "mode": "primary", "hidden": true }])),
        ("GET", ["config"]) => ok(json!({ "model": "opencode/big-pickle" })),
        _ => Response::from_string("no route").with_status_code(404),
    };
    let _ = req.respond(reply);
}

// ---------- Retrace's side ----------

/// A stand-in `opencode` on the PATH: says it is 1.19.5 (so its server is used), nothing else.
fn opencode_bin(dir: &Path) -> Env {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("opencode"), "#!/bin/sh\n[ \"$1\" = --version ] && echo 1.19.5\n").unwrap();
    std::fs::set_permissions(bin.join("opencode"), std::fs::Permissions::from_mode(0o755)).unwrap();
    // A script just written can't run while a process another test forked meanwhile still holds
    // it open for writing (ETXTBSY): wait until it runs once, so Retrace's first try isn't the one.
    let started = Instant::now();
    while std::process::Command::new(bin.join("opencode")).arg("--version").output().is_err() {
        assert!(started.elapsed() < Duration::from_secs(5), "the stand-in opencode doesn't run");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut env = Env::new();
    env.insert("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()));
    env
}

fn repo(base: &Path) -> PathBuf {
    let main = base.join("shop");
    std::fs::create_dir_all(&main).unwrap();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&main).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@e").env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@e").output().unwrap().status.success());
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(main.join("cart.js"), "a\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "init"]);
    main
}

struct Setup {
    _tmp: TempDir,
    fake: Fake,
    config: PathBuf,
    main: PathBuf,
    env: Env,
}

fn setup(name: &str) -> Setup {
    let tmp = temp(name);
    let main = repo(&tmp.0);
    let config = tmp.0.join("config.json");
    std::fs::write(&config, json!({ "projects": [{ "path": main.to_string_lossy() }] }).to_string()).unwrap();
    let env = opencode_bin(&tmp.0);
    Setup { fake: Fake::start(), config, main, env, _tmp: tmp }
}

impl Setup {
    fn state(&self) -> Arc<State> {
        State::with_server(self.config.clone(), self.fake.host(), self.env.clone())
    }

    fn start(&self, state: &State, task: &str, setup: Option<&str>) -> agent::SessionInfo {
        let launch = agent::background_launch(agent::kind("opencode").unwrap(), Open::New, task, setup, vec![("model".into(), "opencode/beam".into())], &self.main, &self.main, &self.env, &state.opencode).unwrap().expect("runs on the server");
        state.agents.spawn(launch, Meta { project: self.main.to_string_lossy().into_owned(), tree: self.main.to_string_lossy().into_owned(), branch: None, agent: "opencode".into(), task: task.into() }).unwrap()
    }
}

fn info(state: &State, id: &str) -> agent::SessionInfo {
    state.agents.list().into_iter().find(|s| s.id == id).unwrap()
}

fn live(state: &State, id: &str) -> Option<(LiveState, Option<String>)> {
    info(state, id).live.map(|l| (l.state, l.detail))
}

fn outline(state: &State, id: &str) -> Vec<String> {
    let t = serde_json::to_value(state.agents.chat(id).unwrap().transcript(0).unwrap()).unwrap();
    t["items"].as_array().unwrap().iter().map(|i| format!("{}{}", i["kind"].as_str().unwrap(), i["text"].as_str().map(|t| format!(":{t}")).unwrap_or_default())).collect()
}

fn say(state: &State, id: &str, text: &str) {
    dispatch(state, "agentPrompt", json!({ "session": id, "text": text })).unwrap();
}

#[test]
fn a_session_runs_on_the_server_and_its_records_come_from_opencodes_messages() {
    let s = setup("turn");
    let state = s.state();
    let session = s.start(&state, "add square", None);
    assert!(session.background && session.chat && session.running);
    wait_for("the turn to end", || outline(&state, &session.id).last().map(String::as_str) == Some("end"));
    assert_eq!(outline(&state, &session.id), ["user:add square", "thought:Look first.", "tool", "message:Added `square`.", "end"]);
    wait_for("idle", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    let t = dispatch(&state, "agentTranscript", json!({ "session": session.id, "after": 0 })).unwrap();
    assert_eq!(t["items"][2]["diffs"], json!([{ "path": "cart.js", "added": 1, "removed": 0 }]));
    // The remembered model was sent and is what the picker shows; the usage is measured against it.
    assert_eq!(t["options"][0]["value"], "opencode/beam");
    assert_eq!(t["options"][1]["choices"].as_array().unwrap().len(), 2, "build and plan, not subagents or hidden ones");
    assert_eq!(t["usage"], json!({ "used": 1200, "size": 100000 }));
    let i = info(&state, &session.id);
    assert!(i.native_id.as_deref().is_some_and(|n| n.starts_with("ses_")));
    assert_eq!(i.title.as_deref(), Some("Add square"));
    state.agents.stop_all();
}

#[test]
fn a_permission_waits_for_the_user_and_the_answer_goes_to_the_server() {
    let s = setup("ask");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    say(&state, &session.id, "PLEASE-ASK clean up");
    wait_for("asking", || live(&state, &session.id) == Some((LiveState::Asking, Some("rm -rf build".into()))));
    assert!(dispatch(&state, "agentPrompt", json!({ "session": session.id, "text": "more" })).is_err(), "busy");
    let t = dispatch(&state, "agentTranscript", json!({ "session": session.id, "after": 0 })).unwrap();
    let ask = t["items"].as_array().unwrap().iter().find(|i| i["kind"] == "ask").unwrap().clone();
    assert_eq!(ask["command"], "rm -rf build");
    assert!(dispatch(&state, "agentAnswer", json!({ "session": session.id, "request": ask["request"], "option": "maybe" })).is_err());
    dispatch(&state, "agentAnswer", json!({ "session": session.id, "request": ask["request"], "option": "once" })).unwrap();
    wait_for("the answer", || outline(&state, &session.id).contains(&"message:Removed it.".to_string()));
    wait_for("idle", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    // The card sits right after the step it is about.
    let kinds: Vec<String> = outline(&state, &session.id).into_iter().map(|k| k.split(':').next().unwrap().to_string()).collect();
    assert_eq!(kinds, ["user", "tool", "ask", "message", "end"]);
    state.agents.stop_all();
}

#[test]
fn quitting_leaves_a_turn_running_and_the_next_retrace_picks_it_up() {
    let s = setup("reattach");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    dispatch(&state, "agentSetOption", json!({ "session": session.id, "option": "mode", "value": "plan" })).unwrap();
    say(&state, &session.id, "SLOW job");
    wait_for("busy", || live(&state, &session.id).is_some_and(|l| l.0 == LiveState::Busy) && info(&state, &session.id).native_id.is_some());
    let native = info(&state, &session.id).native_id.unwrap();
    // Questions the user couldn't answer are kept out of the agent's tools.
    assert_eq!(s.fake.world.lock().unwrap().sessions[0].1.last_prompt["tools"], json!({ "question": false }));
    // Retrace quits: nothing is stopped on the server.
    state.agents.stop_all();
    assert_eq!(s.fake.world.lock().unwrap().aborts, 0);
    wait_for("the turn to finish without Retrace", || !s.fake.world.lock().unwrap().sessions[0].1.busy);

    // The next Retrace: the saved session comes back on its own, with what happened meanwhile.
    let again = s.state();
    let saved = again.agents.list();
    assert!(saved[0].background && !saved[0].running);
    reattach_background(again.clone());
    wait_for("reattached", || again.agents.list().iter().any(|x| x.running && x.native_id.as_deref() == Some(&native)));
    let id = again.agents.list()[0].id.clone();
    wait_for("the full conversation", || outline(&again, &id) == ["user:SLOW job", "message:Done slowly.", "end"]);
    // It keeps its mode: a read-only conversation stays read-only.
    let t = dispatch(&again, "agentTranscript", json!({ "session": id, "after": 0 })).unwrap();
    assert_eq!(t["options"][1]["value"], "plan");
    wait_for("idle", || live(&again, &id) == Some((LiveState::Idle, None)));
    again.agents.stop_all();
}

#[test]
fn a_permission_asked_while_retrace_was_away_is_waiting_when_it_comes_back() {
    let s = setup("away-ask");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    state.agents.stop_all();
    // While Retrace is away, the agent gets to a step that needs the user.
    let sid = s.fake.world.lock().unwrap().sessions[0].0.clone();
    let (world, next) = (s.fake.world.clone(), s.fake.next.clone());
    std::thread::spawn(move || turn(world, next, sid, "PLEASE-ASK".into(), json!({})));
    wait_for("the question", || !s.fake.world.lock().unwrap().asks.is_empty());

    let again = s.state();
    reattach_background(again.clone());
    wait_for("reattached", || again.agents.list().iter().any(|x| x.running));
    let id = again.agents.list()[0].id.clone();
    wait_for("asking", || live(&again, &id) == Some((LiveState::Asking, Some("rm -rf build".into()))));
    let t = dispatch(&again, "agentTranscript", json!({ "session": id, "after": 0 })).unwrap();
    let ask = t["items"].as_array().unwrap().iter().find(|i| i["kind"] == "ask").unwrap().clone();
    dispatch(&again, "agentAnswer", json!({ "session": id, "request": ask["request"], "option": "reject" })).unwrap();
    wait_for("the refusal", || outline(&again, &id).contains(&"message:Left it alone.".to_string()));
    again.agents.stop_all();
}

#[test]
fn stopping_stops_the_turn_resuming_reconnects_and_errors_read_as_the_server_said() {
    let s = setup("stop");
    let state = s.state();
    let session = s.start(&state, "BROKE model", None);
    wait_for("the error", || live(&state, &session.id) == Some((LiveState::Error, Some("insufficient balance (1008)".into()))));
    let lines = outline(&state, &session.id);
    assert_eq!(lines, ["user:BROKE model", "error:insufficient balance (1008)", "end"], "one error, not two");

    say(&state, &session.id, "SLOW job");
    wait_for("busy", || live(&state, &session.id).is_some_and(|l| l.0 == LiveState::Busy));
    dispatch(&state, "agentStop", json!({ "session": session.id })).unwrap();
    let i = info(&state, &session.id);
    assert!(!i.running && i.stopped && i.live.is_none());
    assert_eq!(s.fake.world.lock().unwrap().aborts, 1, "the turn was stopped on the server");
    // How it ended is shown before letting go.
    let t = dispatch(&state, "agentTranscript", json!({ "session": session.id, "after": 0 })).unwrap();
    assert_eq!(t["items"].as_array().unwrap().last().unwrap()["reason"], "cancelled");
    assert!(dispatch(&state, "agentPrompt", json!({ "session": session.id, "text": "hi" })).is_err());

    let resumed = dispatch(&state, "agentResume", json!({ "session": session.id })).unwrap();
    let id = resumed["id"].as_str().unwrap().to_string();
    assert!(resumed["background"].as_bool().unwrap());
    wait_for("idle again", || live(&state, &id) == Some((LiveState::Idle, None)));
    assert!(outline(&state, &id).starts_with(&["user:BROKE model".to_string()]));
    say(&state, &id, "add square");
    wait_for("answered", || outline(&state, &id).contains(&"message:Added `square`.".to_string()));

    // Stop all (quitting with "Stop All"): every turn stops.
    say(&state, &id, "SLOW again");
    wait_for("busy", || live(&state, &id).is_some_and(|l| l.0 == LiveState::Busy));
    dispatch(&state, "agentStopBackground", json!({})).unwrap();
    assert!(!info(&state, &id).running);
    assert_eq!(s.fake.world.lock().unwrap().aborts, 2);
}

#[test]
fn a_failing_setup_command_keeps_the_conversation_from_starting() {
    let s = setup("setup");
    let state = s.state();
    let session = s.start(&state, "never sent", Some("echo installing\necho 'npm ERR! boom' >&2\nexit 4"));
    wait_for("the exit", || !info(&state, &session.id).running);
    let i = info(&state, &session.id);
    assert_eq!((i.exit_code, i.stopped), (Some(4), false));
    let t = dispatch(&state, "agentTranscript", json!({ "session": session.id, "after": 0 })).unwrap();
    assert_eq!(t["items"].as_array().unwrap().len(), 1);
    assert_eq!(t["items"][0]["code"], 4);
    assert!(t["items"][0]["output"].as_str().unwrap().contains("npm ERR! boom"));
    assert!(s.fake.world.lock().unwrap().sessions.is_empty(), "no conversation was opened");

    let ok = s.start(&state, "add square", Some("echo ready in \"$RETRACE_WORKTREE\""));
    wait_for("the turn", || outline(&state, &ok.id).last().map(String::as_str) == Some("end"));
    let t = dispatch(&state, "agentTranscript", json!({ "session": ok.id, "after": 0 })).unwrap();
    assert_eq!(t["items"][0]["output"], format!("ready in {}\n", s.main.display()));
    state.agents.stop_all();
}

#[test]
fn a_server_that_goes_away_ends_the_session_with_a_reason() {
    let s = setup("lost");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    s.fake.down.store(true, Ordering::Relaxed);
    wait_for("given up", || !info(&state, &session.id).running);
    let i = info(&state, &session.id);
    assert_eq!((i.exit_code, i.stopped), (Some(-1), false));
    assert!(outline(&state, &session.id).last().unwrap().starts_with("error:"));
}

#[test]
fn stopping_while_the_setup_command_runs_starts_nothing_on_the_server() {
    let s = setup("stop-setup");
    let state = s.state();
    let session = s.start(&state, "never sent", Some("echo installing; sleep 3; echo done"));
    wait_for("the setup to run", || outline(&state, &session.id) == ["setup"] && serde_json::to_value(state.agents.chat(&session.id).unwrap().transcript(0).unwrap()).unwrap()["items"][0]["output"] == "installing\n");
    dispatch(&state, "agentStop", json!({ "session": session.id })).unwrap();
    let i = info(&state, &session.id);
    assert!(!i.running && i.stopped);
    std::thread::sleep(Duration::from_millis(3500));
    assert!(s.fake.world.lock().unwrap().sessions.is_empty(), "no conversation, no task");
}

#[test]
fn the_server_is_called_idle_only_when_nothing_runs_or_waits_in_any_session_folder() {
    let s = setup("idle");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    let trees = [s.main.clone()];
    assert!(state.opencode.idle_in(&trees));
    say(&state, &session.id, "PLEASE-ASK");
    wait_for("asking", || live(&state, &session.id).is_some_and(|l| l.0 == LiveState::Asking));
    // Busy and waiting for an answer: not idle, so quitting would leave the server running.
    assert!(!state.opencode.idle_in(&trees));
    state.agents.stop_all();
    assert!(!state.opencode.idle_in(&trees), "Retrace letting go changes nothing on the server");
}

#[test]
fn a_conversation_longer_than_ten_megabytes_is_read_in_full() {
    let s = setup("huge");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    say(&state, &session.id, "HUGE answer");
    wait_for("answered", || longest_answer(&state, &session.id) > 10 << 20 && live(&state, &session.id) == Some((LiveState::Idle, None)));
    let native = info(&state, &session.id).native_id.unwrap();
    state.agents.stop_all();

    // Read back whole when Retrace comes back, not taken for an empty conversation.
    let again = s.state();
    reattach_background(again.clone());
    wait_for("reattached", || again.agents.list().iter().any(|x| x.running && x.native_id.as_deref() == Some(&native)));
    let id = again.agents.list()[0].id.clone();
    wait_for("the whole conversation", || longest_answer(&again, &id) > 10 << 20);
    again.agents.stop_all();
}

fn longest_answer(state: &State, id: &str) -> usize {
    let t = serde_json::to_value(state.agents.chat(id).unwrap().transcript(0).unwrap()).unwrap();
    t["items"].as_array().unwrap().iter().filter(|i| i["kind"] == "message").filter_map(|i| i["text"].as_str()).map(str::len).max().unwrap_or(0)
}

#[test]
fn a_setup_command_that_leaves_something_running_doesnt_hold_up_the_conversation() {
    let s = setup("setup-leftover");
    let state = s.state();
    // The `sleep` keeps the setup command's output open long after the command itself is done.
    let session = s.start(&state, "add square", Some("echo ready\nsleep 30 &"));
    wait_for("the turn", || outline(&state, &session.id).last().map(String::as_str) == Some("end"));
    let t = dispatch(&state, "agentTranscript", json!({ "session": session.id, "after": 0 })).unwrap();
    assert_eq!((t["items"][0]["output"].as_str(), t["items"][0]["code"].as_i64()), (Some("ready\n"), Some(0)));
    state.agents.stop_all();
}

#[test]
fn a_conversation_that_cant_be_read_right_now_is_kept_not_replaced() {
    let s = setup("keep");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)) && info(&state, &session.id).native_id.is_some());
    let native = info(&state, &session.id).native_id.unwrap();
    dispatch(&state, "agentStop", json!({ "session": session.id })).unwrap();

    // OpenCode fails to read it for a moment: the resume fails, the conversation stays the same.
    s.fake.world.lock().unwrap().broken_get = true;
    let resumed = dispatch(&state, "agentResume", json!({ "session": session.id })).unwrap();
    let id = resumed["id"].as_str().unwrap().to_string();
    wait_for("the failure", || !info(&state, &id).running);
    assert_eq!(info(&state, &id).native_id.as_deref(), Some(native.as_str()));
    assert_eq!(s.fake.world.lock().unwrap().sessions.len(), 1, "no new conversation");

    // It answers again: resuming picks the same conversation up.
    s.fake.world.lock().unwrap().broken_get = false;
    let again = dispatch(&state, "agentResume", json!({ "session": id })).unwrap();
    let id = again["id"].as_str().unwrap().to_string();
    wait_for("idle", || live(&state, &id) == Some((LiveState::Idle, None)));
    assert_eq!(info(&state, &id).native_id.as_deref(), Some(native.as_str()));
    state.agents.stop_all();
}

#[test]
fn stopping_right_after_sending_also_stops_a_turn_that_starts_late() {
    let s = setup("late");
    let state = s.state();
    let session = s.start(&state, "", None);
    wait_for("open", || live(&state, &session.id) == Some((LiveState::Idle, None)));
    say(&state, &session.id, "LATE SLOW job");
    // At once: OpenCode has the message, but its turn hasn't started when the first abort lands.
    dispatch(&state, "agentStop", json!({ "session": session.id })).unwrap();
    {
        let w = s.fake.world.lock().unwrap();
        assert!(!w.sessions[0].1.busy, "nothing runs once stopped");
        assert_eq!(w.aborts, 2, "the turn that started late was stopped too");
    }
    assert!(!outline(&state, &session.id).contains(&"message:Done slowly.".to_string()));
}

#[test]
fn a_session_the_user_stopped_stays_stopped_when_retrace_comes_back() {
    let s = setup("stays-stopped");
    let state = s.state();
    let kept = s.start(&state, "", None);
    let stopped = s.start(&state, "", None);
    let open = |id: &str| live(&state, id) == Some((LiveState::Idle, None)) && info(&state, id).native_id.is_some();
    wait_for("both open", || open(&kept.id) && open(&stopped.id));
    let (kept_native, stopped_native) = (info(&state, &kept.id).native_id.unwrap(), info(&state, &stopped.id).native_id.unwrap());
    dispatch(&state, "agentStop", json!({ "session": stopped.id })).unwrap();
    // Quitting lets the other one go.
    state.agents.stop_all();

    let again = s.state();
    reattach_background(again.clone());
    wait_for("the one left running", || again.agents.list().iter().any(|x| x.running && x.native_id.as_deref() == Some(&kept_native)));
    std::thread::sleep(Duration::from_millis(500));
    let list = again.agents.list();
    assert!(list.iter().any(|x| !x.running && x.native_id.as_deref() == Some(&stopped_native)), "the stopped one stays stopped");
    again.agents.stop_all();
}

#[test]
fn quitting_stops_only_an_idle_server_and_a_silent_one_is_neither_replaced_nor_forgotten() {
    use std::os::unix::process::CommandExt;
    let s = setup("host");
    let dir = s._tmp.0.join("agents");
    std::fs::create_dir_all(&dir).unwrap();
    // The server's process: a `sleep` in its own group stands in for `opencode serve`.
    let mut server = std::process::Command::new("sleep").arg("60").process_group(0).spawn().unwrap();
    let pid = server.id() as i32;
    let reaper = std::thread::spawn(move || server.wait().unwrap());
    let alive = || unsafe { libc::kill(pid, 0) } == 0;
    let port: u16 = s.fake.url.rsplit(':').next().unwrap().parse().unwrap();
    let saved = dir.join("opencode-server.json");
    std::fs::write(&saved, json!({ "pid": pid, "port": port, "password": "pw" }).to_string()).unwrap();
    let host = Host::new(dir.clone());
    let tree = s.main.clone();

    // Something runs in a session folder: the server stays.
    s.fake.world.lock().unwrap().sessions.push(("ses_x".into(), Conversation { dir: tree.to_string_lossy().into_owned(), busy: true, ..Default::default() }));
    host.stop_if_idle(std::slice::from_ref(&tree));
    assert!(alive() && saved.exists());

    // There but not answering in time: no second server, and not forgotten on "Stop All".
    s.fake.world.lock().unwrap().slow_health = true;
    let err = host.ensure(Path::new("/nonexistent/opencode"), &s.env).err().expect("no second server");
    let err = format!("{err:#}");
    assert!(err.contains("isn't answering") || err.contains("没有回应"), "{err}");
    host.shutdown();
    assert!(alive() && saved.exists());

    // Answering, and nothing runs or waits: stopped, and its record goes with it.
    {
        let mut w = s.fake.world.lock().unwrap();
        w.slow_health = false;
        w.sessions[0].1.busy = false;
    }
    host.stop_if_idle(std::slice::from_ref(&tree));
    assert!(!reaper.join().unwrap().success());
    assert!(!saved.exists());
}
