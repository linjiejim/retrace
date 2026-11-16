//! OpenCode's own headless server (`opencode serve`) as the place an agent's turns run, so they
//! go on while Retrace is closed and can be picked up again. Retrace starts one server per
//! machine, detached from itself, and talks to it over HTTP and its event stream. The server is
//! the OpenCode installed on this machine; nothing of it is built into Retrace.
//!
//! The conversation itself is OpenCode's: its messages and their parts. Retrace keeps a copy in
//! memory (from the event stream, corrected by a full read whenever it connects or a turn ends) and
//! turns it into the records the conversation view shows (`chat.rs`).

use super::acp::Open;
use super::agent::{Live, LiveState};
use super::chat::{self, AskOption, Body, Chat, DiffStat, PlanEntry, Usage};
use super::shell_env::Env;
use crate::tr;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a starting server gets to answer its health check.
const START: Duration = Duration::from_secs(30);
/// A quiet event stream is taken as broken after this long (the server sends heartbeats).
const STREAM_IDLE: Duration = Duration::from_secs(90);
/// The server is taken as gone after failing its health check this many times, half a second apart.
const LOST_AFTER: u32 = 10;
/// The setup command's last output, after it exits, has this long to arrive.
const SETUP_DRAIN: Duration = Duration::from_millis(500);
/// Stopping right after a message was sent: how long the conversation must stay quiet to count
/// as stopped (OpenCode accepts the message before it starts the turn).
const STOP_SETTLE: Duration = Duration::from_millis(1500);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Percent-encoding for a query value.
fn enc(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn alive(pid: i32) -> bool {
    pid > 1 && unsafe { libc::kill(pid, 0) } == 0
}

/// OpenCode 2 changed the server's API (and its messages don't run on 1.x routes): only 1.x is driven this way.
pub fn supported(bin: &Path, env: &Env) -> bool {
    static SEEN: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let seen = SEEN.get_or_init(Default::default);
    if let Some(ok) = seen.lock().ok().and_then(|s| s.get(bin).copied()) {
        return ok;
    }
    // A version that can't be had in time isn't remembered: the next session asks again.
    let Some(version) = version_of(bin, env) else { return false };
    let ok = version.trim().split('.').next().and_then(|m| m.trim_start_matches('v').parse::<u32>().ok()).is_some_and(|major| major == 1);
    if let Ok(mut s) = seen.lock() {
        s.insert(bin.to_path_buf(), ok);
    }
    ok
}

/// `opencode --version`, given a few seconds (it runs while sessions wait to start or resume).
fn version_of(bin: &Path, env: &Env) -> Option<String> {
    let mut child = std::process::Command::new(bin)
        .arg("--version")
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

// ---------- the server ----------

/// A running server: where it is and how to get in.
#[derive(Clone)]
pub struct Endpoint {
    base: String,
    auth: String,
    pid: Option<i32>,
}

fn http(read: Option<Duration>) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3));
    if let Some(r) = read {
        b = b.timeout_read(r);
    }
    b.build()
}

impl Endpoint {
    pub fn new(base: &str, password: &str, pid: Option<i32>) -> Self {
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}")));
        Self { base: base.trim_end_matches('/').to_string(), auth, pid }
    }

    fn call(&self, method: &str, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value> {
        let req = http(Some(timeout)).request(method, &format!("{}{path}", self.base)).set("Authorization", &self.auth);
        let res = match body {
            Some(b) => req.set("Content-Type", "application/json").send_string(&b.to_string()),
            None => req.call(),
        };
        match res {
            Ok(r) => {
                // All of it, however long the conversation: a reply cut short is an error, never "nothing".
                let mut bytes = Vec::new();
                r.into_reader()
                    .read_to_end(&mut bytes)
                    .map_err(|e| anyhow!(tr!("没读完 OpenCode 后台服务的回复：{e}", "Couldn't read the whole reply from OpenCode's background server: {e}")))?;
                let text = String::from_utf8_lossy(&bytes);
                Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.into_owned())) })
            }
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                let message = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.get("data").and_then(|d| d.get("message")).or_else(|| v.get("message")).and_then(Value::as_str).map(str::to_string))
                    .unwrap_or(text);
                Err(anyhow!(Status(code, message.chars().take(300).collect())))
            }
            Err(e) => Err(anyhow!(tr!("连不上 OpenCode 的后台服务：{e}", "Can't reach OpenCode's background server: {e}"))),
        }
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        self.call("GET", path, None, Duration::from_secs(30))
    }

    pub fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.call("POST", path, Some(body), Duration::from_secs(30))
    }

    pub fn healthy(&self) -> bool {
        self.call("GET", "/global/health", None, Duration::from_secs(3)).is_ok_and(|v| v.get("healthy").and_then(Value::as_bool) == Some(true))
    }

    /// Connected, but no answer to the health check in time: there, only busy (or stuck).
    fn silent(&self) -> bool {
        let asked = http(Some(Duration::from_secs(3))).get(&format!("{}/global/health", self.base)).set("Authorization", &self.auth).call();
        asked.is_err_and(|e| e.kind() == ureq::ErrorKind::Io)
    }

    /// The event stream, one `data:` line per event.
    fn events(&self, path: &str) -> Result<Box<dyn Read + Send>> {
        let r = http(Some(STREAM_IDLE)).get(&format!("{}{path}", self.base)).set("Authorization", &self.auth).set("Accept", "text/event-stream").call()?;
        Ok(Box::new(r.into_reader()))
    }
}

/// An HTTP status from the server, with its message.
#[derive(Debug)]
pub struct Status(pub u16, pub String);

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.1.is_empty() { write!(f, "HTTP {}", self.0) } else { f.write_str(&self.1) }
    }
}

impl std::error::Error for Status {}

fn status_of(e: &anyhow::Error) -> Option<u16> {
    e.downcast_ref::<Status>().map(|s| s.0)
}

/// Whether `GET /session/status` says this conversation is running; None when the reply isn't
/// that list (an error page, a cut-off body): nothing to go by.
fn running_in(status: &Value, id: &str) -> Option<bool> {
    let all = status.as_object()?;
    Some(all.get(id).is_some_and(|x| s(x, "type").is_none_or(|t| t != "idle")))
}

/// The machine's OpenCode server: found from its state file, or started.
pub struct Host {
    /// Holds the state file and the server's log.
    dir: PathBuf,
    current: Mutex<Option<Endpoint>>,
    starting: Mutex<()>,
    /// A server given from outside (tests): never started or stopped here.
    fixed: bool,
}

impl Host {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, current: Mutex::new(None), starting: Mutex::new(()), fixed: false }
    }

    /// A server that is already there (and stays there).
    pub fn attached(endpoint: Endpoint) -> Self {
        Self { dir: PathBuf::new(), current: Mutex::new(Some(endpoint)), starting: Mutex::new(()), fixed: true }
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join("opencode-server.json")
    }

    /// The server if it is running (one this Retrace or an earlier one started); never starts one.
    pub fn find(&self) -> Option<Endpoint> {
        let current = self.current.lock().ok().and_then(|c| c.clone());
        if let Some(ep) = &current {
            if ep.healthy() {
                return Some(ep.clone());
            }
        }
        if self.fixed {
            return None;
        }
        let ep = self.saved()?;
        // Asked just now, no answer: once is enough.
        if current.is_some_and(|c| c.base == ep.base && c.pid == ep.pid) || !ep.healthy() {
            return None;
        }
        if let Ok(mut c) = self.current.lock() {
            *c = Some(ep.clone());
        }
        Some(ep)
    }

    /// The server in the state file, while its process is there (it may not be ours any more).
    fn saved(&self) -> Option<Endpoint> {
        let saved: Value = std::fs::read(self.state_path()).ok().and_then(|b| serde_json::from_slice(&b).ok())?;
        let pid = saved.get("pid").and_then(Value::as_i64)? as i32;
        let port = saved.get("port").and_then(Value::as_u64)?;
        let password = saved.get("password").and_then(Value::as_str)?;
        alive(pid).then(|| Endpoint::new(&format!("http://127.0.0.1:{port}"), password, Some(pid)))
    }

    /// The saved server is there but doesn't answer in time: not to be replaced by a second
    /// one (two servers on one OpenCode store), nor forgotten.
    fn silent(&self) -> bool {
        !self.fixed && self.saved().is_some_and(|ep| ep.silent())
    }

    /// The running server, started if there is none. Its own process session: it outlives Retrace.
    pub fn ensure(&self, bin: &Path, env: &Env) -> Result<Endpoint> {
        let _one = self.starting.lock().map_err(|_| anyhow!("server"))?;
        if let Some(ep) = self.find() {
            return Ok(ep);
        }
        if self.fixed {
            bail!(tr!("OpenCode 的后台服务不在了", "OpenCode's background server is gone"));
        }
        if self.silent() {
            bail!(tr!("OpenCode 的后台服务没有回应，稍后再试", "OpenCode's background server isn't answering. Try again in a moment."));
        }
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::process::CommandExt;
        std::fs::create_dir_all(&self.dir).with_context(|| tr!("无法创建 {}", "Can't create {}", self.dir.display()))?;
        let port = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let mut secret = [0u8; 18];
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut secret))?;
        let password: String = secret.iter().map(|b| format!("{b:02x}")).collect();
        let log = std::fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(self.dir.join("opencode-server.log"))?;
        let mut cmd = std::process::Command::new(bin);
        cmd.args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()])
            .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
            .env_clear()
            // One server for every worktree: nothing of the session that happened to start it.
            .envs(env.iter().filter(|(k, _)| !k.starts_with("RETRACE_")))
            .env("OPENCODE_SERVER_USERNAME", "opencode")
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        // Its own session: not in Retrace's process group, not tied to a terminal Retrace may have.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| anyhow!(tr!("无法启动 OpenCode 的后台服务：{e}", "Can't start OpenCode's background server: {e}")))?;
        let pid = child.id() as i32;
        let ep = Endpoint::new(&format!("http://127.0.0.1:{port}"), &password, Some(pid));
        let deadline = Instant::now() + START;
        loop {
            if ep.healthy() {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                let tail = std::fs::read_to_string(self.dir.join("opencode-server.log")).unwrap_or_default();
                let tail: String = tail.trim().chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
                bail!(tr!("OpenCode 的后台服务没起来（{status}）：{tail}", "OpenCode's background server didn't start ({status}): {tail}"));
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                bail!(tr!("OpenCode 的后台服务 30 秒内没有回应", "OpenCode's background server didn't answer within 30 seconds"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Reaped here while Retrace runs; after that it belongs to nobody, on purpose.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        let state = json!({ "pid": pid, "port": port, "password": password, "started": now_ms() });
        let tmp = self.state_path().with_extension("json.tmp");
        let written = std::fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&tmp).and_then(|mut f| f.write_all(state.to_string().as_bytes())).and_then(|_| std::fs::rename(&tmp, self.state_path()));
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            bail!(tr!("无法保存 OpenCode 后台服务的信息：{e}", "Can't save OpenCode's background server details: {e}"));
        }
        if let Ok(mut c) = self.current.lock() {
            *c = Some(ep.clone());
        }
        Ok(ep)
    }

    /// Stop the server if it says nothing is running or waiting for an answer in these folders.
    /// The question and the stop go to the same server; one that can't be reached is left alone
    /// (it may be busy and only slow to answer).
    pub fn stop_if_idle(&self, dirs: &[PathBuf]) {
        if self.fixed {
            return;
        }
        let Some(ep) = self.find() else { return };
        if idle_at(&ep, dirs) {
            self.kill(ep.pid);
        }
    }

    /// Nothing is running or waiting for an answer in these folders, by the server's own word
    /// (false when it can't be asked).
    pub fn idle_in(&self, dirs: &[PathBuf]) -> bool {
        self.find().is_some_and(|ep| idle_at(&ep, dirs))
    }

    /// Stop the server (and with it every turn in it).
    pub fn shutdown(&self) {
        if self.fixed {
            return;
        }
        // Only a process that answers with our password is ours: a saved pid may belong to
        // someone else by now (the server died, the Mac restarted).
        match self.find() {
            Some(ep) => self.kill(ep.pid),
            // There but not answering: not stopped unasked, and not forgotten either.
            None if self.silent() => {}
            None => self.kill(None),
        }
    }

    fn kill(&self, pid: Option<i32>) {
        if let Ok(mut c) = self.current.lock() {
            *c = None;
        }
        if let Some(pid) = pid.filter(|p| alive(*p)) {
            // Its own process group: what its tools started goes too.
            unsafe {
                libc::killpg(pid, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            while alive(pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            if alive(pid) {
                unsafe {
                    libc::killpg(pid, libc::SIGKILL);
                }
            }
        }
        let _ = std::fs::remove_file(self.state_path());
    }
}

/// The server says nothing runs or waits for an answer in any of these folders (false when a
/// question goes unanswered).
fn idle_at(ep: &Endpoint, dirs: &[PathBuf]) -> bool {
    dirs.iter().all(|d| {
        let q = format!("directory={}", enc(&d.to_string_lossy()));
        ep.get(&format!("/session/status?{q}")).is_ok_and(|v| v.as_object().is_some_and(|o| o.is_empty())) && ep.get(&format!("/permission?{q}")).is_ok_and(|v| v.as_array().is_some_and(|a| a.is_empty()))
    })
}

// ---------- OpenCode's messages as Retrace's records ----------

#[derive(Default, Clone)]
struct Msg {
    id: String,
    info: Value,
    parts: Vec<Value>,
}

#[derive(Clone)]
struct Ask {
    id: String,
    request: u64,
    call: Option<String>,
    body: Body,
}

/// What Retrace knows of one conversation on the server.
#[derive(Default)]
struct Model {
    messages: Vec<Msg>,
    /// Parts read in a full snapshot while they may still be streaming: increments that arrive
    /// for them may already be in the snapshot, so they wait for the part's next full update.
    frozen: std::collections::HashSet<String>,
    asks: Vec<Ask>,
    busy: bool,
    /// An error the server reported for the session but no message carries (e.g. before the first step).
    session_error: Option<String>,
    title: Option<String>,
    /// The model the session last ran with (`provider/model`), and its mode (OpenCode's agent).
    model: Option<String>,
    mode: Option<String>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    chat::text_of(v, key)
}

fn ask_options() -> Vec<AskOption> {
    vec![
        AskOption { id: "once".into(), name: "Allow once".into(), kind: "allow_once".into() },
        AskOption { id: "always".into(), name: "Always allow".into(), kind: "allow_always".into() },
        AskOption { id: "reject".into(), name: "Reject".into(), kind: "reject_once".into() },
    ]
}

/// A turn ended this way (`cancelled` when the user stopped it).
fn error_text(info: &Value) -> Option<(bool, String)> {
    let e = info.get("error")?;
    if e.is_null() {
        return None;
    }
    let name = s(e, "name").unwrap_or_default();
    let message = e.get("data").and_then(|d| s(d, "message")).or_else(|| s(e, "message")).unwrap_or_else(|| name.clone());
    Some((name == "MessageAbortedError", message))
}

impl Model {
    fn message_mut(&mut self, id: &str) -> &mut Msg {
        let at = match self.messages.binary_search_by(|m| m.id.as_str().cmp(id)) {
            Ok(i) => i,
            Err(i) => {
                self.messages.insert(i, Msg { id: id.to_string(), ..Default::default() });
                i
            }
        };
        &mut self.messages[at]
    }

    /// The full list from `GET /session/{id}/message`.
    fn set_messages(&mut self, list: &Value) {
        let mut out: Vec<Msg> = list
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let info = m.get("info")?.clone();
                let id = s(&info, "id")?;
                let mut parts: Vec<Value> = m.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
                parts.sort_by(|a, b| s(a, "id").cmp(&s(b, "id")));
                Some(Msg { id, info, parts })
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        self.frozen = out.iter().flat_map(|m| m.parts.iter().filter_map(|p| s(p, "id"))).collect();
        self.messages = out;
    }

    fn upsert_part(&mut self, part: &Value) {
        let (Some(mid), Some(pid)) = (s(part, "messageID"), s(part, "id")) else { return };
        self.frozen.remove(&pid);
        let m = self.message_mut(&mid);
        match m.parts.binary_search_by(|p| s(p, "id").unwrap_or_default().cmp(&pid)) {
            Ok(i) => m.parts[i] = part.clone(),
            Err(i) => m.parts.insert(i, part.clone()),
        }
    }

    fn add_ask(&mut self, p: &Value, next: &AtomicU64, rel: &dyn Fn(&[String]) -> Vec<String>) {
        let Some(id) = s(p, "id") else { return };
        if self.asks.iter().any(|a| a.id == id) {
            return;
        }
        let permission = s(p, "permission").unwrap_or_default();
        let patterns: Vec<String> = p.get("patterns").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
        let meta = p.get("metadata").cloned().unwrap_or(Value::Null);
        let tool = match permission.as_str() {
            "bash" => "execute",
            "edit" | "write" | "patch" => "edit",
            "read" => "read",
            "webfetch" | "websearch" => "fetch",
            "glob" | "grep" | "list" => "search",
            _ => "other",
        };
        let command = if tool == "execute" { s(&meta, "command").or_else(|| (!patterns.is_empty()).then(|| patterns.join(" "))) } else { None };
        let paths = if command.is_none() { rel(&patterns) } else { vec![] };
        let title = command.clone().or_else(|| paths.first().cloned()).unwrap_or_else(|| permission.clone());
        let request = next.fetch_add(1, Ordering::Relaxed);
        self.asks.push(Ask { id, request, call: p.get("tool").and_then(|t| s(t, "callID")), body: Body::Ask { request, title, tool: tool.into(), command, paths, options: ask_options(), answer: None } });
    }

    fn answer(&mut self, id: &str, reply: &str) {
        for a in &mut self.asks {
            if a.id == id {
                if let Body::Ask { answer: answer @ None, .. } = &mut a.body {
                    *answer = Some(reply.to_string());
                }
            }
        }
    }

    fn waiting(&self) -> Vec<&Ask> {
        self.asks.iter().filter(|a| matches!(a.body, Body::Ask { answer: None, .. })).collect()
    }

    /// One event from the stream; whether it was about this session.
    fn apply(&mut self, event: &Value, session: &str, next: &AtomicU64, rel: &dyn Fn(&[String]) -> Vec<String>) -> bool {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let p = event.get("properties").cloned().unwrap_or(Value::Null);
        let sid = s(&p, "sessionID").or_else(|| p.get("info").and_then(|i| s(i, "sessionID"))).or_else(|| p.get("part").and_then(|i| s(i, "sessionID")));
        if sid.as_deref() != Some(session) {
            return false;
        }
        match kind {
            "message.updated" => {
                if let Some(info) = p.get("info") {
                    if let Some(id) = s(info, "id") {
                        self.message_mut(&id).info = info.clone();
                    }
                }
            }
            "message.removed" => {
                if let Some(id) = s(&p, "messageID") {
                    self.messages.retain(|m| m.id != id);
                }
            }
            "message.part.updated" => {
                if let Some(part) = p.get("part") {
                    self.upsert_part(part);
                }
            }
            "message.part.removed" => {
                if let (Some(mid), Some(pid)) = (s(&p, "messageID"), s(&p, "partID")) {
                    self.message_mut(&mid).parts.retain(|x| s(x, "id").as_deref() != Some(&pid));
                }
            }
            "message.part.delta" => {
                let (Some(mid), Some(pid), Some(field), Some(delta)) = (s(&p, "messageID"), s(&p, "partID"), s(&p, "field"), s(&p, "delta")) else { return true };
                if self.frozen.contains(&pid) {
                    return true;
                }
                let m = self.message_mut(&mid);
                match m.parts.iter_mut().find(|x| s(x, "id").as_deref() == Some(&pid)) {
                    Some(part) => {
                        let now = s(part, &field).unwrap_or_default();
                        part[field.as_str()] = Value::String(now + &delta);
                    }
                    None => {
                        // The part itself hasn't arrived yet: a text part is the only kind that streams.
                        let mut part = json!({ "id": pid, "messageID": mid, "sessionID": session, "type": "text" });
                        part[field.as_str()] = Value::String(delta);
                        let at = m.parts.partition_point(|x| s(x, "id").unwrap_or_default() < pid);
                        m.parts.insert(at, part);
                    }
                }
            }
            "session.status" => {
                self.busy = p.get("status").and_then(|st| s(st, "type")).is_some_and(|t| t != "idle");
                if self.busy {
                    self.session_error = None;
                }
            }
            "session.idle" => self.busy = false,
            "session.error" => {
                if let Some((aborted, text)) = error_text(&p) {
                    if !aborted {
                        self.session_error = Some(text);
                    }
                }
            }
            "session.updated" => {
                if let Some(info) = p.get("info") {
                    self.title = s(info, "title");
                    if let Some(m) = info.get("model") {
                        if let (Some(provider), Some(model)) = (s(m, "providerID"), s(m, "id").or_else(|| s(m, "modelID"))) {
                            self.model = Some(format!("{provider}/{model}"));
                        }
                    }
                }
            }
            "permission.asked" => self.add_ask(&p, next, rel),
            "permission.replied" => {
                if let (Some(id), Some(reply)) = (s(&p, "requestID"), s(&p, "reply")) {
                    self.answer(&id, &reply);
                }
            }
            _ => return false,
        }
        true
    }

    /// The conversation as records, keyed, in order; and how the last turn stands.
    /// `settled`: nothing is running or about to (a message sent, the server not busy yet).
    fn render(&self, settled: bool, rel_path: &dyn Fn(&str) -> String, shown: &dyn Fn(&[String]) -> Vec<String>) -> Rendered {
        let mut out: Vec<(String, Body)> = Vec::new();
        let mut placed = std::collections::HashSet::new();
        // Turns: each user message, and the assistant messages that answer it.
        let users: Vec<&Msg> = self.messages.iter().filter(|m| s(&m.info, "role").as_deref() == Some("user")).collect();
        let mut last_error = None;
        let mut last_usage = None;
        for (ti, user) in users.iter().enumerate() {
            let text: Vec<String> = user.parts.iter().filter(|p| s(p, "type").as_deref() == Some("text") && !p.get("synthetic").and_then(Value::as_bool).unwrap_or(false)).filter_map(|p| s(p, "text")).collect();
            if !text.is_empty() {
                out.push((format!("u:{}", user.id), Body::User { text: text.join("\n") }));
            }
            let answers: Vec<&Msg> = self.messages.iter().filter(|m| s(&m.info, "role").as_deref() == Some("assistant") && s(&m.info, "parentID").as_deref() == Some(&user.id)).collect();
            let mut aborted = false;
            let mut failed = None;
            let mut finish = None;
            for m in &answers {
                for part in &m.parts {
                    let Some(pid) = s(part, "id") else { continue };
                    match s(part, "type").as_deref() {
                        Some("text") => {
                            let t = s(part, "text").unwrap_or_default();
                            if !t.trim().is_empty() && !part.get("synthetic").and_then(Value::as_bool).unwrap_or(false) {
                                out.push((pid, Body::Message { text: t }));
                            }
                        }
                        Some("reasoning") => {
                            let t = s(part, "text").unwrap_or_default();
                            if !t.trim().is_empty() {
                                out.push((pid, Body::Thought { text: t }));
                            }
                        }
                        Some("tool") => {
                            out.push((pid, tool_body(part, rel_path, shown)));
                            if let Some(call) = s(part, "callID") {
                                for a in self.asks.iter().filter(|a| a.call.as_deref() == Some(&call)) {
                                    out.push((format!("ask:{}", a.id), a.body.clone()));
                                    placed.insert(a.id.clone());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if let Some((was_abort, text)) = error_text(&m.info) {
                    if was_abort {
                        aborted = true;
                    } else {
                        out.push((format!("e:{}", m.id), Body::Error { text: text.clone() }));
                        failed = Some(text);
                    }
                }
                if let Some(f) = s(&m.info, "finish") {
                    finish = Some(f);
                }
                if let Some(t) = m.info.get("tokens").filter(|t| t.is_object()) {
                    let n = |k: &str| t.get(k).and_then(Value::as_u64).unwrap_or(0);
                    let cache = |k: &str| t.get("cache").and_then(|c| c.get(k)).and_then(Value::as_u64).unwrap_or(0);
                    let used = n("input") + n("output") + n("reasoning") + cache("read") + cache("write");
                    if used > 0 {
                        let model = match (s(&m.info, "providerID"), s(&m.info, "modelID")) {
                            (Some(p), Some(id)) => Some(format!("{p}/{id}")),
                            _ => None,
                        };
                        last_usage = Some((used, model));
                    }
                }
            }
            let last = ti + 1 == users.len();
            // An error only the session reported: once the turn is over (by then a message that carries it has arrived).
            if last && settled && !self.busy {
                if let Some(e) = self.session_error.clone().filter(|_| failed.is_none()) {
                    out.push((format!("se:{}", user.id), Body::Error { text: e.clone() }));
                    failed = Some(e);
                }
            }
            // Over unless it is the last turn and the session is still at it (or about to be).
            if !last || (settled && !self.busy && (!answers.is_empty() || failed.is_some())) {
                let reason = if aborted {
                    "cancelled"
                } else if failed.is_some() {
                    "error"
                } else if finish.as_deref() == Some("length") {
                    "max_tokens"
                } else {
                    "end_turn"
                };
                out.push((format!("end:{}", user.id), Body::End { reason: reason.into() }));
                if last {
                    last_error = failed;
                }
            }
        }
        // Permissions for a step not seen yet, at the end.
        for a in self.asks.iter().filter(|a| !placed.contains(&a.id)) {
            out.push((format!("ask:{}", a.id), a.body.clone()));
        }
        Rendered { records: out, last_error, usage: last_usage }
    }
}

struct Rendered {
    records: Vec<(String, Body)>,
    last_error: Option<String>,
    /// Context in use after the last step, and the model it ran on.
    usage: Option<(u64, Option<String>)>,
}

fn tool_body(part: &Value, rel: &dyn Fn(&str) -> String, shown: &dyn Fn(&[String]) -> Vec<String>) -> Body {
    let name = s(part, "tool").unwrap_or_default();
    let state = part.get("state").cloned().unwrap_or(Value::Null);
    let input = state.get("input").cloned().unwrap_or(Value::Null);
    if name == "todowrite" {
        let entries = input.get("todos").and_then(Value::as_array).into_iter().flatten().filter_map(|t| Some(PlanEntry { text: s(t, "content")?, status: s(t, "status").unwrap_or_else(|| "pending".into()) })).collect();
        return Body::Plan { entries };
    }
    let tool = match name.as_str() {
        "bash" => "execute",
        "read" => "read",
        "edit" | "write" | "patch" | "multiedit" | "apply_patch" => "edit",
        "glob" | "grep" | "list" | "codesearch" => "search",
        "webfetch" | "websearch" => "fetch",
        _ => "other",
    };
    let status = match s(&state, "status").as_deref() {
        Some("running") => "in_progress",
        Some("completed") => "completed",
        Some("error") => "failed",
        _ => "pending",
    };
    let command = s(&input, "command");
    let file = s(&input, "filePath").or_else(|| s(&input, "path"));
    let paths = shown(&file.clone().into_iter().collect::<Vec<_>>());
    let title = s(&state, "title").filter(|t| !t.is_empty()).or_else(|| command.clone()).or_else(|| paths.first().cloned()).unwrap_or_else(|| name.clone());
    let mut output = s(&state, "output").or_else(|| s(&state, "error"));
    if let Some(o) = &mut output {
        chat::tail(o, chat::OUTPUT_MAX);
    }
    let mut diffs = Vec::new();
    if tool == "edit" && status == "completed" {
        let meta = state.get("metadata").cloned().unwrap_or(Value::Null);
        // A patch over several files lists them, each with its counts.
        let files: Vec<&Value> = meta.get("files").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        if !files.is_empty() {
            for f in files {
                let path = f.as_str().map(str::to_string).or_else(|| s(f, "filePath").or_else(|| s(f, "file")).or_else(|| s(f, "path")));
                let Some(path) = path else { continue };
                let n = |k: &str| f.get(k).and_then(Value::as_u64).unwrap_or(0) as usize;
                diffs.push(DiffStat { path: rel(&path), added: n("additions"), removed: n("deletions") });
            }
        } else if let Some(fd) = meta.get("filediff").filter(|f| f.is_object()) {
            if let Some(path) = s(fd, "file").or_else(|| file.clone()) {
                let n = |k: &str| fd.get(k).and_then(Value::as_u64).unwrap_or(0) as usize;
                diffs.push(DiffStat { path: rel(&path), added: n("additions"), removed: n("deletions") });
            }
        } else if let Some(path) = file.clone() {
            let (added, removed) = match (s(&input, "oldString"), s(&input, "newString"), s(&input, "content")) {
                (Some(old), Some(new), _) => chat::line_stats(&old, &new),
                (_, _, Some(content)) => (content.lines().count(), 0),
                _ => (0, 0),
            };
            if added + removed > 0 {
                diffs.push(DiffStat { path: rel(&path), added, removed });
            }
        }
    }
    Body::Tool { tool: tool.into(), title, status: status.into(), paths, command, output, diffs }
}

// ---------- one conversation ----------

pub struct Plan {
    pub host: Arc<Host>,
    pub bin: PathBuf,
    /// The login shell's environment (for the setup command, and a server started for this session).
    pub env: Env,
    pub cwd: PathBuf,
    pub open: Open,
    /// The first message of a new conversation.
    pub task: String,
    /// The user's last choices (`model`, …).
    pub options: Vec<(String, String)>,
    pub setup: Option<String>,
}

#[derive(Default)]
struct Phase {
    opening: bool,
    /// A message was sent and the server hasn't said it is busy yet.
    sent: bool,
    worked: bool,
    /// Sending failed, or opening did.
    error: Option<String>,
    /// How the server says the last turn failed.
    turn_error: Option<String>,
    session: Option<String>,
    /// Model and mode for the next message.
    model: Option<String>,
    mode: Option<String>,
    /// `provider/model` → context window.
    limits: HashMap<String, u64>,
    shown: Option<(LiveState, Option<String>, i64)>,
}

type Changed = Box<dyn Fn(&Conn) + Send + Sync>;
type Ended = Box<dyn Fn(i32, bool) + Send + Sync>;

pub struct Conn {
    host: Arc<Host>,
    cwd: PathBuf,
    dir: String,
    endpoint: Mutex<Option<Endpoint>>,
    model: Mutex<Model>,
    chat: Mutex<Chat>,
    phase: Mutex<Phase>,
    next: AtomicU64,
    /// No longer followed (stopped, closed, or Retrace is quitting): nothing reports any more.
    detached: AtomicBool,
    /// The user stopped it: nothing new may start (an opening session doesn't send its task).
    stopping: AtomicBool,
    /// Held while a message goes out, so a stop can't slip in between deciding to send and sending.
    sending: Mutex<()>,
    /// Retrace is quitting: nothing new goes to the server (what runs there keeps running).
    leaving: AtomicBool,
    setup_pid: Mutex<Option<u32>>,
    started: i64,
    changed: Changed,
    ended: Ended,
}

impl Conn {
    pub fn start(plan: Plan, changed: impl Fn(&Conn) + Send + Sync + 'static, ended: impl Fn(i32, bool) + Send + Sync + 'static) -> Arc<Conn> {
        let mut chat = Chat::new(&plan.cwd);
        if let Some(setup) = &plan.setup {
            chat.setup_started(setup);
        }
        let conn = Arc::new(Conn {
            host: plan.host.clone(),
            cwd: plan.cwd.clone(),
            dir: enc(&plan.cwd.to_string_lossy()),
            endpoint: Mutex::new(None),
            model: Default::default(),
            chat: Mutex::new(chat),
            // A conversation being picked up again is known before it is open: stopping meanwhile
            // must still reach its turn on the server.
            phase: Mutex::new(Phase { opening: true, session: match &plan.open { Open::Id(id) => Some(id.clone()), _ => None }, ..Default::default() }),
            next: AtomicU64::new(1),
            detached: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            sending: Mutex::new(()),
            leaving: AtomicBool::new(false),
            setup_pid: Mutex::new(None),
            started: now_ms(),
            changed: Box::new(changed),
            ended: Box::new(ended),
        });
        let me = conn.clone();
        std::thread::spawn(move || me.open(plan));
        conn
    }

    fn notify(&self) {
        if !self.detached.load(Ordering::Relaxed) {
            (self.changed)(self);
        }
    }

    fn end(&self, code: i32) {
        // A stop in progress says how it ended (stopped), not what the stop caused (a killed setup
        // command); so does Retrace quitting.
        if self.stopping.load(Ordering::Relaxed) || self.leaving.load(Ordering::Relaxed) {
            return;
        }
        if !self.detached.swap(true, Ordering::Relaxed) {
            (self.ended)(code, false);
        }
    }

    fn ep(&self) -> Result<Endpoint> {
        self.endpoint.lock().ok().and_then(|e| e.clone()).ok_or_else(|| anyhow!(tr!("agent 还没准备好", "The agent isn't ready yet")))
    }

    fn q(&self) -> String {
        format!("directory={}", self.dir)
    }

    fn fail_opening(&self, text: String) {
        let _ = self.chat.lock().map(|mut c| c.error(&text));
        if let Ok(mut p) = self.phase.lock() {
            p.opening = false;
            p.error = Some(text);
        }
        self.notify();
        self.end(1);
    }

    fn open(self: Arc<Self>, plan: Plan) {
        if let Some(setup) = &plan.setup {
            let code = self.run_setup(setup, &plan);
            let _ = self.chat.lock().map(|mut c| c.setup_finished(code));
            self.notify();
            if code != 0 || self.detached.load(Ordering::Relaxed) {
                return self.end(code);
            }
        }
        let ep = match plan.host.ensure(&plan.bin, &plan.env) {
            Ok(ep) => ep,
            Err(e) => return self.fail_opening(format!("{e:#}")),
        };
        // Stopped before anything was opened: open nothing. A conversation picked up again goes on
        // opening: a stop that fails to reach its turn must leave it working.
        if self.leaving.load(Ordering::Relaxed) || (self.stopping.load(Ordering::Relaxed) && plan.open == Open::New) {
            return;
        }
        if let Ok(mut e) = self.endpoint.lock() {
            *e = Some(ep.clone());
        }
        let wanted = match &plan.open {
            Open::New => None,
            Open::Id(id) => Some(id.clone()),
            Open::Latest => self.latest(&ep),
        };
        let mut id = None;
        if let Some(want) = wanted {
            match ep.get(&format!("/session/{want}?{}", self.q())) {
                Ok(info) => {
                    id = Some(want);
                    self.take_session_info(&info);
                }
                // Gone from OpenCode: say so, then go on with a fresh conversation.
                Err(e) if status_of(&e) == Some(404) => {
                    let reason = format!("{e:#}");
                    let _ = self.chat.lock().map(|mut c| c.error(&tr!("没能载入之前的对话，这是一段新的：{reason}", "Couldn't load the earlier conversation, so this is a new one: {reason}")));
                }
                // Anything else (slow, failing) may pass: keep the conversation to try again, never
                // swap it for a new one.
                Err(e) => return self.fail_opening(format!("{e:#}")),
            }
        }
        let id = match id {
            Some(id) => id,
            None => match ep.post(&format!("/session?{}", self.q()), json!({})) {
                Ok(info) => match s(&info, "id") {
                    Some(id) => id,
                    None => return self.fail_opening(tr!("OpenCode 没有给出会话 id", "OpenCode didn't return a session id")),
                },
                Err(e) => return self.fail_opening(format!("{e:#}")),
            },
        };
        self.load_options(&ep, &plan.options);
        let task = plan.task.trim().to_string();
        let send_task = plan.open == Open::New && !task.is_empty();
        // Open: messages and answers can go from here on (the stream catches up with them). With a
        // task about to go, it counts as sent already, so the session doesn't look idle meanwhile.
        if let Ok(mut p) = self.phase.lock() {
            p.session = Some(id.clone());
            p.opening = false;
            p.sent = send_task;
        }
        // Follow the stream first, then read everything: nothing that happens in between is missed.
        let me = self.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let followed = id.clone();
        std::thread::spawn(move || me.follow(followed, ready_tx));
        let _ = ready_rx.recv_timeout(Duration::from_secs(10));
        if send_task {
            // Refused when the user stopped it meanwhile.
            let _ = self.submit(&id, &task);
        }
        self.notify();
    }

    fn run_setup(self: &Arc<Self>, setup: &str, plan: &Plan) -> i32 {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        let child = std::process::Command::new("/bin/sh")
            .args(["-e", "-c", setup])
            .current_dir(&plan.cwd)
            .env_clear()
            .envs(&plan.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let _ = self.chat.lock().map(|mut c| c.setup_output(&format!("{e}\n")));
                return 127;
            }
        };
        let pid = child.id();
        if let Ok(mut p) = self.setup_pid.lock() {
            *p = Some(pid);
        }
        // Output is shown until the command is done (and a moment after): whatever it left running
        // in the background may hold the pipes open for good, and is read but no longer shown.
        let shown = Arc::new(AtomicBool::new(true));
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let mut readers = 0;
        for mut r in [child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>), child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>)].into_iter().flatten() {
            readers += 1;
            let (me, shown, done) = (self.clone(), shown.clone(), done_tx.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if shown.load(Ordering::Relaxed) {
                        let _ = me.chat.lock().map(|mut c| c.setup_output(&String::from_utf8_lossy(&buf[..n])));
                        me.notify();
                    }
                }
                let _ = done.send(());
            });
        }
        // Exited but not yet reaped, so its pid (and group id) can't be someone else's while a stop
        // may still signal it; the pid is cleared and the process reaped under the same lock.
        super::agent::wait_exit_unreaped(pid as i32);
        let code = {
            let mut p = self.setup_pid.lock().ok();
            if let Some(p) = p.as_deref_mut() {
                *p = None;
            }
            child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1)
        };
        let deadline = Instant::now() + SETUP_DRAIN;
        for _ in 0..readers {
            if done_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() {
                break;
            }
        }
        shown.store(false, Ordering::Relaxed);
        code
    }

    fn latest(&self, ep: &Endpoint) -> Option<String> {
        let list = ep.get(&format!("/session?{}", self.q())).ok()?;
        let here = std::fs::canonicalize(&self.cwd).unwrap_or_else(|_| self.cwd.clone());
        list.as_array()?
            .iter()
            .filter(|x| s(x, "directory").is_some_and(|d| Path::new(&d) == here || std::fs::canonicalize(&d).is_ok_and(|p| p == here)))
            .max_by_key(|x| x.get("time").and_then(|t| t.get("updated")).and_then(Value::as_i64).unwrap_or(0))
            .and_then(|x| s(x, "id"))
    }

    fn take_session_info(&self, info: &Value) {
        if let Ok(mut m) = self.model.lock() {
            m.title = s(info, "title");
            if let Some(agent) = s(info, "agent") {
                m.mode = Some(agent);
            }
            if let Some(model) = info.get("model") {
                if let (Some(p), Some(id)) = (s(model, "providerID"), s(model, "id").or_else(|| s(model, "modelID"))) {
                    m.model = Some(format!("{p}/{id}"));
                }
            }
        }
    }

    /// The models and modes OpenCode offers here, with the user's choices applied where they fit.
    fn load_options(&self, ep: &Endpoint, chosen: &[(String, String)]) {
        let providers = ep.get(&format!("/config/providers?{}", self.q())).unwrap_or(Value::Null);
        let agents = ep.get(&format!("/agent?{}", self.q())).unwrap_or(Value::Null);
        let config = ep.get(&format!("/config?{}", self.q())).unwrap_or(Value::Null);
        let mut models = Vec::new();
        let mut limits = HashMap::new();
        for p in providers.get("providers").and_then(Value::as_array).into_iter().flatten() {
            let (Some(pid), pname) = (s(p, "id"), s(p, "name")) else { continue };
            let mut list: Vec<&Value> = p.get("models").and_then(Value::as_object).map(|m| m.values().collect()).unwrap_or_default();
            list.sort_by_key(|m| s(m, "name").unwrap_or_default());
            for m in list {
                let Some(mid) = s(m, "id") else { continue };
                let value = format!("{pid}/{mid}");
                if let Some(ctx) = m.get("limit").and_then(|l| l.get("context")).and_then(Value::as_u64) {
                    limits.insert(value.clone(), ctx);
                }
                models.push(json!({ "value": value, "name": format!("{}/{}", pname.clone().unwrap_or(pid.clone()), s(m, "name").unwrap_or(mid)) }));
            }
        }
        let modes: Vec<Value> = agents
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| s(a, "mode").as_deref() != Some("subagent") && !a.get("hidden").and_then(Value::as_bool).unwrap_or(false))
            .filter_map(|a| Some(json!({ "value": s(a, "name")?, "name": s(a, "name")?, "description": s(a, "description") })))
            .collect();
        let offered = |list: &[Value], v: &str| list.iter().any(|x| x.get("value").and_then(Value::as_str) == Some(v));
        let pick = |id: &str| chosen.iter().find(|(k, _)| k == id).map(|(_, v)| v.clone());
        let (session_model, session_mode) = self.model.lock().map(|m| (m.model.clone(), m.mode.clone())).unwrap_or_default();
        let default_model = s(&config, "model").or_else(|| {
            let d = providers.get("default")?.as_object()?;
            let (p, m) = d.iter().find(|(p, _)| p.as_str() == "opencode").or_else(|| d.iter().next())?;
            Some(format!("{p}/{}", m.as_str()?))
        });
        let model = [session_model, pick("model"), default_model].into_iter().flatten().find(|m| offered(&models, m)).or_else(|| models.first().and_then(|m| s(m, "value")));
        let default_mode = s(&config, "default_agent").unwrap_or_else(|| "build".into());
        // A conversation picked up again keeps its mode: a read-only one stays read-only.
        let mode = [session_mode, pick("mode"), Some(default_mode)].into_iter().flatten().find(|m| offered(&modes, m)).or_else(|| modes.first().and_then(|m| s(m, "value")));
        if let Ok(mut p) = self.phase.lock() {
            p.model = model.clone();
            p.mode = mode.clone();
            p.limits = limits;
        }
        let mut options = Vec::new();
        if let Some(m) = &model {
            options.push(json!({ "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": m, "options": models }));
        }
        if let Some(m) = &mode {
            options.push(json!({ "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": m, "options": modes }));
        }
        let _ = self.chat.lock().map(|mut c| c.set_options(&Value::Array(options)));
    }

    /// Read the whole conversation, what runs and what waits, then show it.
    fn refresh(&self, ep: &Endpoint, id: &str) {
        // Status first: a turn that is over by then has all its messages in the read that follows.
        let status = ep.get(&format!("/session/status?{}", self.q()));
        let messages = ep.get(&format!("/session/{id}/message?{}", self.q()));
        let asks = ep.get(&format!("/permission?{}", self.q()));
        let info = ep.get(&format!("/session/{id}?{}", self.q()));
        if let Ok(info) = &info {
            self.take_session_info(info);
        }
        let shown = self.shown_fn();
        if let Ok(mut m) = self.model.lock() {
            // Only a reply of the right shape replaces what is shown: anything else says nothing.
            if let Some(list) = messages.as_ref().ok().filter(|l| l.is_array()) {
                m.set_messages(list);
            }
            if let Some(busy) = status.as_ref().ok().and_then(|st| running_in(st, id)) {
                m.busy = busy;
            }
            if let Some(list) = asks.as_ref().ok().filter(|l| l.is_array()) {
                let waiting: Vec<String> = list.as_array().into_iter().flatten().filter(|a| s(a, "sessionID").as_deref() == Some(id)).filter_map(|a| s(a, "id")).collect();
                // Ones answered elsewhere (or while Retrace was away) are no longer waiting.
                for a in m.asks.iter_mut() {
                    if let Body::Ask { answer: answer @ None, .. } = &mut a.body {
                        if !waiting.contains(&a.id) {
                            *answer = Some("answered".into());
                        }
                    }
                }
                for a in list.as_array().into_iter().flatten().filter(|a| s(a, "sessionID").as_deref() == Some(id)) {
                    m.add_ask(a, &self.next, &shown);
                }
            }
        }
        // Locks in one order everywhere: model, then chat, then phase.
        let busy = self.model.lock().is_ok_and(|m| m.busy);
        if busy {
            if let Ok(mut p) = self.phase.lock() {
                p.sent = false;
            }
        }
        self.show();
    }

    fn shown_fn(&self) -> impl Fn(&[String]) -> Vec<String> + '_ {
        move |paths: &[String]| self.chat.lock().map(|c| c.shown(paths)).unwrap_or_else(|_| paths.to_vec())
    }

    /// Records, usage and state from the model, then tell whoever listens.
    fn show(&self) {
        let rendered = {
            let Ok(m) = self.model.lock() else { return };
            let Ok(c) = self.chat.lock() else { return };
            let rel = |p: &str| c.relative(p);
            let shown = |p: &[String]| c.shown(p);
            let sent = self.phase.lock().is_ok_and(|p| p.sent);
            m.render(!sent, &rel, &shown)
        };
        let busy = self.model.lock().is_ok_and(|m| m.busy);
        let (limits, current) = self.phase.lock().map(|mut p| {
            // The server's verdict on the last turn, once it is over.
            if !busy && !p.sent {
                p.turn_error = rendered.last_error.clone();
            }
            (p.limits.clone(), p.model.clone())
        }).unwrap_or_default();
        let usage = rendered.usage.and_then(|(used, model)| Some(Usage { used, size: *limits.get(&model.or(current)?)? }));
        let _ = self.chat.lock().map(|mut c| {
            c.sync(rendered.records);
            c.set_usage(usage);
        });
        self.notify();
    }

    /// The event stream, reconnecting while the server is there; gives up when it is gone.
    fn follow(self: Arc<Self>, id: String, ready: std::sync::mpsc::Sender<()>) {
        let mut ready = Some(ready);
        let mut failures = 0;
        loop {
            if self.detached.load(Ordering::Relaxed) {
                return;
            }
            let Ok(ep) = self.ep() else { return };
            match ep.events(&format!("/event?{}", self.q())) {
                Ok(stream) => {
                    failures = 0;
                    self.refresh(&ep, &id);
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(());
                    }
                    let shown = self.shown_fn();
                    for line in BufReader::new(stream).lines() {
                        if self.detached.load(Ordering::Relaxed) {
                            return;
                        }
                        let Ok(line) = line else { break };
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else { continue };
                        let kind = event.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                        let relevant = self.model.lock().map(|mut m| m.apply(&event, &id, &self.next, &shown)).unwrap_or(false);
                        if !relevant {
                            continue;
                        }
                        if kind == "session.status" && self.model.lock().is_ok_and(|m| m.busy) {
                            if let Ok(mut p) = self.phase.lock() {
                                p.sent = false;
                            }
                        }
                        if kind == "session.idle" || kind == "session.error" {
                            if let Ok(mut p) = self.phase.lock() {
                                p.sent = false;
                            }
                            // The turn is over: settle on the server's own account of it.
                            self.refresh(&ep, &id);
                        } else {
                            self.show();
                        }
                    }
                }
                Err(_) => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(());
                    }
                }
            }
            if self.detached.load(Ordering::Relaxed) {
                return;
            }
            if ep.healthy() {
                failures = 0;
            } else {
                failures += 1;
                if failures >= LOST_AFTER {
                    let _ = self.chat.lock().map(|mut c| c.error(&tr!("OpenCode 的后台服务停了，这一轮没有跑完。", "OpenCode's background server stopped; this turn didn't finish.")));
                    if let Ok(mut p) = self.phase.lock() {
                        p.error = Some(tr!("后台服务停了", "The background server stopped"));
                    }
                    self.notify();
                    return self.end(-1);
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    // ---------- what the user does ----------

    fn session(&self) -> Result<String> {
        if self.detached.load(Ordering::Relaxed) {
            bail!(tr!("会话已经结束", "The session has ended"));
        }
        let p = self.phase.lock().map_err(|_| anyhow!("conversation"))?;
        match (&p.session, p.opening) {
            (Some(id), false) => Ok(id.clone()),
            _ => bail!(tr!("agent 还没准备好", "The agent isn't ready yet")),
        }
    }

    fn working(&self) -> bool {
        self.model.lock().is_ok_and(|m| m.busy) || self.phase.lock().is_ok_and(|p| p.sent)
    }

    pub fn prompt(&self, text: &str) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            bail!(tr!("消息是空的", "The message is empty"));
        }
        let id = self.session()?;
        if self.working() {
            bail!(tr!("agent 还在忙，先停止这一轮再发", "The agent is still working; stop this turn before sending"));
        }
        self.submit(&id, text)
    }

    /// Send a message (whether one may be sent now is the caller's question).
    fn submit(&self, id: &str, text: &str) -> Result<()> {
        let _sending = self.sending.lock().map_err(|_| anyhow!("conversation"))?;
        if self.stopping.load(Ordering::Relaxed) || self.leaving.load(Ordering::Relaxed) {
            if let Ok(mut p) = self.phase.lock() {
                p.sent = false;
            }
            bail!(tr!("会话已经结束", "The session has ended"));
        }
        let (model, mode) = {
            let mut p = self.phase.lock().map_err(|_| anyhow!("conversation"))?;
            p.sent = true;
            p.worked = true;
            p.error = None;
            p.turn_error = None;
            (p.model.clone(), p.mode.clone())
        };
        if let Ok(mut m) = self.model.lock() {
            m.session_error = None;
        }
        self.notify();
        let mut body = json!({ "parts": [{ "type": "text", "text": text }] });
        if let Some((provider, model)) = model.as_deref().and_then(|m| m.split_once('/')) {
            body["model"] = json!({ "providerID": provider, "modelID": model });
        }
        if let Some(mode) = mode {
            body["agent"] = json!(mode);
        }
        // OpenCode's server lets the agent ask the user multiple-choice questions; Retrace has no
        // way to answer those (nor did ACP), and an unanswered one would hold the turn forever.
        body["tools"] = json!({ "question": false });
        let sent = self.ep().and_then(|ep| ep.post(&format!("/session/{id}/prompt_async?{}", self.q()), body));
        if let Err(e) = sent {
            let reason = format!("{e:#}");
            let _ = self.chat.lock().map(|mut c| c.error(&tr!("没发出去：{reason}", "Not sent: {reason}")));
            if let Ok(mut p) = self.phase.lock() {
                p.sent = false;
                p.error = Some(reason.clone());
            }
            self.notify();
            bail!(reason);
        }
        Ok(())
    }

    pub fn cancel(&self) -> Result<()> {
        let id = self.session()?;
        self.ep()?.post(&format!("/session/{id}/abort?{}", self.q()), json!({}))?;
        if let Ok(mut p) = self.phase.lock() {
            p.sent = false;
        }
        self.notify();
        Ok(())
    }

    pub fn answer(&self, request: u64, option: &str) -> Result<()> {
        self.session()?;
        if !["once", "always", "reject"].contains(&option) {
            bail!(tr!("agent 没有这个选项：{option}", "The agent doesn't offer this: {option}"));
        }
        let perm = self.model.lock().ok().and_then(|m| m.waiting().into_iter().find(|a| a.request == request).map(|a| a.id.clone())).ok_or_else(|| anyhow!(tr!("这个请求已经回答过了", "This request has already been answered")))?;
        self.ep()?.post(&format!("/permission/{perm}/reply?{}", self.q()), json!({ "reply": option }))?;
        if let Ok(mut m) = self.model.lock() {
            m.answer(&perm, option);
        }
        self.show();
        Ok(())
    }

    pub fn set_option(&self, option: &str, value: &str) -> Result<()> {
        self.session()?;
        let known = self.chat.lock().map(|c| c.options().iter().any(|o| o.id == option && o.choices.iter().any(|c| c.value == value))).unwrap_or(false);
        if !known {
            bail!(tr!("agent 没有这个选项：{option} = {value}", "The agent doesn't offer this: {option} = {value}"));
        }
        if let Ok(mut p) = self.phase.lock() {
            match option {
                "model" => p.model = Some(value.to_string()),
                "mode" => p.mode = Some(value.to_string()),
                _ => {}
            }
        }
        // The options list is Retrace's own here: change the current value in it.
        let options: Vec<Value> = self
            .chat
            .lock()
            .map(|c| {
                c.options()
                    .iter()
                    .map(|o| {
                        let current = if o.id == option { value.to_string() } else { o.value.clone() };
                        let choices: Vec<Value> = o.choices.iter().map(|c| json!({ "value": c.value, "name": c.name, "description": c.description })).collect();
                        json!({ "id": o.id, "name": o.name, "category": o.category, "type": "select", "currentValue": current, "options": choices })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let _ = self.chat.lock().map(|mut c| c.set_options(&Value::Array(options)));
        self.notify();
        Ok(())
    }

    /// Stopped by the user: the turn in progress stops, then Retrace stops following. The
    /// conversation stays in OpenCode. Fails (and keeps following) when OpenCode is there but the
    /// turn doesn't stop: the agent would go on changing files in a session shown as stopped.
    pub fn stop(&self) -> Result<()> {
        self.stopping.store(true, Ordering::Relaxed);
        // A message on its way out arrives before the stop does.
        drop(self.sending.lock());
        self.kill_setup();
        // Sent, but not yet seen running: the turn may start after the abort lands.
        let pending = self.phase.lock().is_ok_and(|p| p.sent);
        let id = self.phase.lock().ok().and_then(|p| p.session.clone());
        let ep = self.endpoint.lock().ok().and_then(|e| e.clone()).or_else(|| self.host.find());
        let (Some(id), Some(ep)) = (id, ep) else {
            // No conversation on a server: nothing runs there.
            self.detached.store(true, Ordering::Relaxed);
            return Ok(());
        };
        // The server's own word: what Retrace has read of it may not be complete yet.
        // A status that can't be read counts as busy: better a needless stop than a missed one.
        let remote_busy = ep.get(&format!("/session/status?{}", self.q())).ok().and_then(|st| running_in(&st, &id)).unwrap_or(true);
        if remote_busy || self.has_work() {
            let abort = || ep.call("POST", &format!("/session/{id}/abort?{}", self.q()), Some(json!({})), Duration::from_secs(5));
            if let Err(e) = abort() {
                if ep.healthy() {
                    self.stopping.store(false, Ordering::Relaxed);
                    bail!(tr!("OpenCode 没有停下这一轮：{e:#}", "OpenCode didn't stop the turn: {e:#}"));
                }
                // The server is gone: so is the turn.
                self.detached.store(true, Ordering::Relaxed);
                return Ok(());
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            let busy = || ep.get(&format!("/session/status?{}", self.q())).ok().and_then(|st| running_in(&st, &id)).unwrap_or(true);
            // Stopped means quiet: at once, or for a moment when a message was just sent (and a
            // turn that starts in that moment is stopped too).
            let quiet_for = if pending { STOP_SETTLE } else { Duration::ZERO };
            let mut quiet_since: Option<Instant> = None;
            loop {
                if busy() {
                    if quiet_since.take().is_some() {
                        let _ = abort();
                    }
                    if Instant::now() > deadline {
                        if !ep.healthy() {
                            // The server went away meanwhile, and its turn with it.
                            self.detached.store(true, Ordering::Relaxed);
                            return Ok(());
                        }
                        self.stopping.store(false, Ordering::Relaxed);
                        bail!(tr!("OpenCode 5 秒内没有停下这一轮", "OpenCode didn't stop the turn within 5 seconds"));
                    }
                } else if quiet_since.get_or_insert_with(Instant::now).elapsed() >= quiet_for || Instant::now() > deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if let Ok(mut p) = self.phase.lock() {
                p.sent = false;
            }
            // How it ended (stopped), before letting go.
            self.refresh(&ep, &id);
        }
        self.detached.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Retrace is going away: stop following, leave the turn running. Nothing new is sent after
    /// this returns (a message on its way out has arrived).
    pub fn detach(&self) {
        self.leaving.store(true, Ordering::Relaxed);
        drop(self.sending.lock());
        self.kill_setup();
        self.detached.store(true, Ordering::Relaxed);
    }

    /// The setup command and what it started. Under the lock that clears its pid once it has
    /// exited: never a group id that may be someone else's by now.
    fn kill_setup(&self) {
        if let Ok(p) = self.setup_pid.lock() {
            if let Some(pid) = *p {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
            }
        }
    }

    /// A turn in progress or a permission waiting: something to come back to.
    pub fn has_work(&self) -> bool {
        self.working() || self.model.lock().is_ok_and(|m| !m.waiting().is_empty())
    }

    pub fn host(&self) -> Arc<Host> {
        self.host.clone()
    }

    // ---------- what the rest of Retrace reads ----------

    pub fn transcript(&self, after: u64) -> Result<super::acp::Transcript> {
        let chat = self.chat.lock().map_err(|_| anyhow!("conversation"))?;
        Ok(super::acp::Transcript { rev: chat.rev(), items: chat.since(after), options: chat.options().to_vec(), usage: chat.usage() })
    }

    pub fn native_id(&self) -> Option<String> {
        self.phase.lock().ok().and_then(|p| p.session.clone())
    }

    pub fn title(&self) -> Option<String> {
        self.model.lock().ok().and_then(|m| m.title.clone())
    }

    pub fn live(&self) -> Live {
        let asking = self.model.lock().ok().and_then(|m| m.waiting().first().map(|a| match &a.body {
            Body::Ask { title, .. } => title.clone(),
            _ => String::new(),
        }));
        let busy = self.working() || self.phase.lock().is_ok_and(|p| p.opening);
        let mut p = match self.phase.lock() {
            Ok(p) => p,
            Err(_) => return Live { state: LiveState::Idle, detail: None, worked: false, since: self.started, at: self.started },
        };
        let error = p.turn_error.clone().or_else(|| p.error.clone());
        let (state, detail) = match (asking, busy, &error) {
            (Some(d), _, _) => (LiveState::Asking, Some(d)),
            (None, true, _) => (LiveState::Busy, None),
            (None, false, Some(e)) => (LiveState::Error, Some(e.clone())),
            (None, false, None) => (LiveState::Idle, None),
        };
        let at = match &p.shown {
            Some((st, d, at)) if *st == state && *d == detail => *at,
            _ => now_ms(),
        };
        p.shown = Some((state, detail.clone(), at));
        Live { state, detail, worked: p.worked, since: self.started, at }
    }

    /// The conversation is still there on the server (it can be picked up again): anything but
    /// OpenCode saying it doesn't know it.
    pub fn exists(ep: &Endpoint, cwd: &Path, id: &str) -> bool {
        match ep.get(&format!("/session/{id}?directory={}", enc(&cwd.to_string_lossy()))) {
            Ok(_) => true,
            Err(e) => status_of(&e) != Some(404),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> String {
        p.strip_prefix("/w/").unwrap_or(p).to_string()
    }
    fn shown(p: &[String]) -> Vec<String> {
        p.iter().map(|x| rel(x)).collect()
    }
    fn keys(m: &Model) -> Vec<String> {
        m.render(true, &rel, &shown).records.into_iter().map(|(k, b)| format!("{k}={}", serde_json::to_value(&b).unwrap()["kind"].as_str().unwrap())).collect()
    }

    fn turn() -> Model {
        let mut m = Model::default();
        m.set_messages(&json!([
            { "info": { "id": "msg_1", "role": "user" }, "parts": [{ "id": "prt_1", "type": "text", "text": "add square" }] },
            { "info": { "id": "msg_2", "role": "assistant", "parentID": "msg_1", "finish": "tool-calls", "providerID": "opencode", "modelID": "big-pickle",
                        "tokens": { "input": 100, "output": 10, "reasoning": 0, "cache": { "read": 900, "write": 0 } } },
              "parts": [
                { "id": "prt_2", "type": "step-start" },
                { "id": "prt_3", "type": "reasoning", "text": "Look first." },
                { "id": "prt_4", "type": "tool", "tool": "bash", "callID": "c1", "state": { "status": "completed", "input": { "command": "ls" }, "output": "cart.js\n", "title": "ls" } },
                { "id": "prt_5", "type": "tool", "tool": "edit", "callID": "c2", "state": { "status": "completed", "input": { "filePath": "/w/cart.js", "oldString": "a", "newString": "a\nb" }, "title": "cart.js",
                  "metadata": { "filediff": { "file": "/w/cart.js", "additions": 1, "deletions": 0 } } } }
              ] },
            { "info": { "id": "msg_3", "role": "assistant", "parentID": "msg_1", "finish": "stop" }, "parts": [{ "id": "prt_6", "type": "text", "text": "Done." }] }
        ]));
        m
    }

    #[test]
    fn a_turn_becomes_your_words_the_steps_the_answer_and_an_end() {
        let m = turn();
        assert_eq!(keys(&m), ["u:msg_1=user", "prt_3=thought", "prt_4=tool", "prt_5=tool", "prt_6=message", "end:msg_1=end"]);
        let r = m.render(true, &rel, &shown);
        assert_eq!(r.records[3].1, Body::Tool { tool: "edit".into(), title: "cart.js".into(), status: "completed".into(), paths: vec!["cart.js".into()], command: None, output: None, diffs: vec![DiffStat { path: "cart.js".into(), added: 1, removed: 0 }] });
        assert_eq!(r.usage, Some((1010, Some("opencode/big-pickle".into()))));
        assert_eq!(r.last_error, None);
    }

    #[test]
    fn a_running_turn_has_no_end_yet_and_text_streams_in() {
        let mut m = turn();
        m.busy = true;
        assert!(!keys(&m).contains(&"end:msg_1=end".to_string()));
        let next = AtomicU64::new(1);
        let ev = |delta: &str| json!({ "type": "message.part.delta", "properties": { "sessionID": "s", "messageID": "msg_3", "partID": "prt_7", "field": "text", "delta": delta } });
        assert!(m.apply(&ev("More "), "s", &next, &shown));
        assert!(m.apply(&ev("text."), "s", &next, &shown));
        // Not this session's.
        assert!(!m.apply(&json!({ "type": "session.idle", "properties": { "sessionID": "other" } }), "s", &next, &shown));
        let r = m.render(true, &rel, &shown);
        assert!(r.records.iter().any(|(k, b)| k == "prt_7" && *b == Body::Message { text: "More text.".into() }));
        assert!(m.apply(&json!({ "type": "session.idle", "properties": { "sessionID": "s" } }), "s", &next, &shown));
        assert!(keys(&m).last().unwrap().starts_with("end:"));
    }

    #[test]
    fn a_permission_sits_after_its_step_until_answered() {
        let mut m = turn();
        m.busy = true;
        let next = AtomicU64::new(7);
        m.apply(&json!({ "type": "permission.asked", "properties": { "id": "per_1", "sessionID": "s", "permission": "bash", "patterns": ["ls"], "metadata": { "command": "ls" }, "tool": { "messageID": "msg_2", "callID": "c1" } } }), "s", &next, &shown);
        assert_eq!(keys(&m)[3], "ask:per_1=ask");
        let w = m.waiting();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].request, 7);
        assert!(matches!(&w[0].body, Body::Ask { command: Some(c), tool, .. } if c == "ls" && tool == "execute"));
        m.apply(&json!({ "type": "permission.replied", "properties": { "sessionID": "s", "requestID": "per_1", "reply": "once" } }), "s", &next, &shown);
        assert!(m.waiting().is_empty());
        // The same request seen again (a full read) isn't a second one.
        m.add_ask(&json!({ "id": "per_1", "sessionID": "s", "permission": "bash" }), &next, &shown);
        assert_eq!(m.asks.len(), 1);
    }

    #[test]
    fn errors_and_stops_end_a_turn_their_own_way() {
        let mut m = Model::default();
        m.set_messages(&json!([
            { "info": { "id": "msg_1", "role": "user" }, "parts": [{ "id": "p1", "type": "text", "text": "one" }] },
            { "info": { "id": "msg_2", "role": "assistant", "parentID": "msg_1", "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } } }, "parts": [] },
            { "info": { "id": "msg_3", "role": "user" }, "parts": [{ "id": "p2", "type": "text", "text": "two" }] },
            { "info": { "id": "msg_4", "role": "assistant", "parentID": "msg_3", "error": { "name": "APIError", "data": { "message": "insufficient balance (1008)" } } }, "parts": [] }
        ]));
        let r = m.render(true, &rel, &shown);
        let ends: Vec<_> = r.records.iter().filter_map(|(_, b)| if let Body::End { reason } = b { Some(reason.as_str()) } else { None }).collect();
        assert_eq!(ends, ["cancelled", "error"]);
        assert!(r.records.iter().any(|(_, b)| *b == Body::Error { text: "insufficient balance (1008)".into() }));
        assert_eq!(r.last_error.as_deref(), Some("insufficient balance (1008)"));
    }

    #[test]
    fn a_todo_list_is_the_plan() {
        let b = tool_body(&json!({ "tool": "todowrite", "state": { "status": "completed", "input": { "todos": [{ "content": "read", "status": "completed" }, { "content": "edit", "status": "in_progress" }] } } }), &rel, &shown);
        assert_eq!(b, Body::Plan { entries: vec![PlanEntry { text: "read".into(), status: "completed".into() }, PlanEntry { text: "edit".into(), status: "in_progress".into() }] });
    }

    #[test]
    fn increments_for_a_part_read_in_a_snapshot_wait_for_its_next_full_update() {
        let mut m = Model::default();
        m.set_messages(&json!([{ "info": { "id": "msg_1", "role": "assistant" }, "parts": [{ "id": "prt_1", "messageID": "msg_1", "type": "text", "text": "Hello world" }] }]));
        let next = AtomicU64::new(1);
        let delta = json!({ "type": "message.part.delta", "properties": { "sessionID": "s", "messageID": "msg_1", "partID": "prt_1", "field": "text", "delta": " world" } });
        // Already in the snapshot, maybe: not added twice.
        m.apply(&delta, "s", &next, &shown);
        assert_eq!(m.messages[0].parts[0]["text"], "Hello world");
        m.apply(&json!({ "type": "message.part.updated", "properties": { "sessionID": "s", "part": { "id": "prt_1", "messageID": "msg_1", "type": "text", "text": "Hello world!" } } }), "s", &next, &shown);
        m.apply(&delta, "s", &next, &shown);
        assert_eq!(m.messages[0].parts[0]["text"], "Hello world! world");
    }

    #[test]
    fn a_patch_over_several_files_counts_each() {
        let b = tool_body(&json!({ "tool": "apply_patch", "state": { "status": "completed", "input": {}, "title": "2 files", "metadata": { "files": [{ "filePath": "/w/a.js", "additions": 3, "deletions": 1 }, { "filePath": "/w/b.js", "additions": 0, "deletions": 2 }] } } }), &rel, &shown);
        let Body::Tool { tool, diffs, .. } = b else { panic!() };
        assert_eq!(tool, "edit");
        assert_eq!(diffs, vec![DiffStat { path: "a.js".into(), added: 3, removed: 1 }, DiffStat { path: "b.js".into(), added: 0, removed: 2 }]);
    }

    #[test]
    fn a_saved_pid_that_isnt_our_server_is_left_alone() {
        use std::os::unix::process::CommandExt;
        let dir = std::env::temp_dir().join(format!("retrace-host-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Someone else's process now has the pid the state file names (the server died, the pid was reused).
        let mut stranger = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        std::fs::write(dir.join("opencode-server.json"), json!({ "pid": stranger.id(), "port": port, "password": "x" }).to_string()).unwrap();
        let host = Host::new(dir.clone());
        assert!(host.find().is_none());
        host.stop_if_idle(&[dir.clone()]);
        host.shutdown();
        assert!(stranger.try_wait().unwrap().is_none(), "still running");
        assert!(!dir.join("opencode-server.json").exists());
        let _ = stranger.kill();
        let _ = stranger.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(enc("/tmp/a b/中"), "/tmp/a%20b/%E4%B8%AD");
    }
}
