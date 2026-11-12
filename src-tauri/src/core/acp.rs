//! Retrace as an ACP client (Agent Client Protocol: JSON-RPC, one message per line, over the
//! agent's standard input and output). The agent is a program installed on this machine that
//! Retrace starts (`opencode acp`); nothing of it is built into Retrace. Retrace offers the agent
//! no file or terminal access of its own: the agent uses its own tools.
//!
//! One connection is one conversation. What arrives is folded into a `Chat` (see `chat.rs`).

use super::agent::{Live, LiveState};
use super::chat::{Chat, ConfigOption, Item, Usage};
use crate::tr;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const PROTOCOL: u64 = 1;
const HANDSHAKE: Duration = Duration::from_secs(30);
/// Opening a conversation loads the agent's providers, plugins and (for an old one) its history.
const OPEN: Duration = Duration::from_secs(120);
const SHORT: Duration = Duration::from_secs(30);
/// The end of the agent's standard error kept, to show if it dies.
const STDERR_MAX: usize = 8 * 1024;
/// After the process exits, how long to wait for what it last wrote to be read.
const DRAIN: Duration = Duration::from_millis(500);

/// Which conversation to open.
#[derive(Debug, Clone, PartialEq)]
pub enum Open {
    New,
    /// The agent's own id for a conversation Retrace followed before.
    Id(String),
    /// The latest conversation in this worktree (a session saved without an id), else a new one.
    Latest,
}

pub struct Plan {
    pub cwd: PathBuf,
    pub open: Open,
    /// Sent as the first message of a new conversation; never when reopening one.
    pub task: String,
    /// The user's last choices (`configOptions` id → value), applied where the agent has them.
    pub options: Vec<(String, String)>,
    /// The setup command running in the same process before the agent (its output is on stderr).
    pub setup: Option<String>,
}

enum Failure {
    /// The agent is gone; whoever watches the process reports why.
    Closed,
    Timeout,
    Rpc(String),
}

impl Failure {
    fn text(&self, doing: &str) -> String {
        match self {
            Failure::Closed => tr!("agent 已经退出", "The agent has exited"),
            Failure::Timeout => tr!("agent 没有回应（{doing}）", "The agent didn't answer ({doing})"),
            Failure::Rpc(message) => message.clone(),
        }
    }
}

#[derive(Default)]
struct Phase {
    /// The conversation is open: messages can be sent.
    ready: bool,
    /// Opening, or a turn in progress.
    busy: bool,
    worked: bool,
    /// The last turn (or opening the conversation) failed.
    error: Option<String>,
    /// The agent's id for the conversation.
    session: Option<String>,
    title: Option<String>,
    closed: bool,
    /// What the session's state was last reported as, and since when.
    shown: Option<(LiveState, Option<String>, i64)>,
}

type Reply = mpsc::Sender<Result<Value, Failure>>;

pub struct Conn {
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    chat: Mutex<Chat>,
    phase: Mutex<Phase>,
    /// The agent's requests still waiting for the user: Retrace's number → the JSON-RPC id.
    asks: Mutex<HashMap<u64, Value>>,
    stderr: Mutex<String>,
    /// How many of the two output streams (stdout, stderr) have been read to their end.
    drained: (Mutex<u8>, Condvar),
    cwd: PathBuf,
    started: i64,
    /// Called after anything changed.
    changed: Box<dyn Fn(&Conn) + Send + Sync>,
}

#[derive(Serialize)]
pub struct Transcript {
    pub rev: u64,
    pub items: Vec<Item>,
    pub options: Vec<ConfigOption>,
    pub usage: Option<Usage>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The agent's wording without the JSON-RPC wrapper.
fn rpc_message(error: &Value) -> String {
    let text = error.get("message").and_then(Value::as_str).unwrap_or("").trim();
    let text = text.strip_prefix("Internal error:").map(str::trim).unwrap_or(text);
    if text.is_empty() { tr!("agent 报错了，没有说明原因", "The agent reported an error without saying why") } else { text.to_string() }
}

impl Conn {
    /// Talk to an agent over its pipes and open the conversation `plan` asks for.
    pub fn start(stdin: impl Write + Send + 'static, stdout: impl Read + Send + 'static, stderr: impl Read + Send + 'static, plan: Plan, changed: impl Fn(&Conn) + Send + Sync + 'static) -> Arc<Conn> {
        let mut chat = Chat::new(&plan.cwd);
        if let Some(setup) = &plan.setup {
            chat.setup_started(setup);
        }
        let conn = Arc::new(Conn {
            stdin: Mutex::new(Some(Box::new(stdin))),
            pending: Default::default(),
            next: AtomicU64::new(1),
            chat: Mutex::new(chat),
            phase: Mutex::new(Phase { busy: true, ..Default::default() }),
            asks: Default::default(),
            stderr: Default::default(),
            drained: Default::default(),
            cwd: plan.cwd.clone(),
            started: now_ms(),
            changed: Box::new(changed),
        });
        let me = conn.clone();
        std::thread::spawn(move || me.read(stdout));
        let me = conn.clone();
        std::thread::spawn(move || me.read_stderr(stderr));
        let me = conn.clone();
        std::thread::spawn(move || me.open(plan));
        conn
    }

    fn notify(&self) {
        (self.changed)(self);
    }

    // ---------- the wire ----------

    fn send(&self, message: &Value) -> Result<(), Failure> {
        let mut line = serde_json::to_vec(message).map_err(|_| Failure::Closed)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().map_err(|_| Failure::Closed)?;
        let pipe = stdin.as_mut().ok_or(Failure::Closed)?;
        if pipe.write_all(&line).and_then(|_| pipe.flush()).is_err() {
            *stdin = None;
            return Err(Failure::Closed);
        }
        Ok(())
    }

    /// A request and its answer. `timeout`: none for a turn, which takes as long as it takes.
    fn call(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, Failure> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| Failure::Closed)?;
            if self.phase.lock().map(|p| p.closed).unwrap_or(true) {
                return Err(Failure::Closed);
            }
            pending.insert(id, tx);
        }
        if let Err(e) = self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
            let _ = self.pending.lock().map(|mut p| p.remove(&id));
            return Err(e);
        }
        let answer = match timeout {
            Some(t) => rx.recv_timeout(t).map_err(|e| if e == mpsc::RecvTimeoutError::Timeout { Failure::Timeout } else { Failure::Closed }),
            None => rx.recv().map_err(|_| Failure::Closed),
        };
        let _ = self.pending.lock().map(|mut p| p.remove(&id));
        answer?
    }

    fn read(self: Arc<Self>, stdout: impl Read) {
        for line in BufReader::new(stdout).split(b'\n') {
            let Ok(line) = line else { break };
            // Anything that isn't a message (a stray log line) is skipped.
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
            if !message.is_object() {
                continue;
            }
            self.receive(message);
        }
        // The agent closed its output: nothing more will be answered.
        if let Ok(mut phase) = self.phase.lock() {
            phase.closed = true;
            phase.ready = false;
            phase.busy = false;
        }
        let waiting: Vec<Reply> = self.pending.lock().map(|mut p| p.drain().map(|(_, tx)| tx).collect()).unwrap_or_default();
        for tx in waiting {
            let _ = tx.send(Err(Failure::Closed));
        }
        self.dismiss_asks();
        self.stream_ended();
        self.notify();
    }

    fn stream_ended(&self) {
        if let Ok(mut done) = self.drained.0.lock() {
            *done += 1;
            self.drained.1.notify_all();
        }
    }

    fn receive(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").filter(|id| !id.is_null());
        match (method, id) {
            // The agent's answer to one of our requests.
            (None, Some(id)) => {
                let tx = id.as_u64().and_then(|id| self.pending.lock().ok()?.remove(&id));
                if let Some(tx) = tx {
                    let _ = tx.send(match message.get("error") {
                        Some(error) => Err(Failure::Rpc(rpc_message(error))),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    });
                }
            }
            (Some("session/update"), _) => {
                if let Some(update) = message.get("params").and_then(|p| p.get("update")) {
                    // The user's messages come from the agent only while it replays an old
                    // conversation; in a live turn Retrace has already recorded what was sent.
                    let echo = update.get("sessionUpdate").and_then(Value::as_str) == Some("user_message_chunk") && self.phase.lock().map(|p| p.ready).unwrap_or(false);
                    if echo {
                        return;
                    }
                    if let Ok(mut chat) = self.chat.lock() {
                        chat.apply(update);
                    }
                    self.notify();
                }
            }
            (Some("session/request_permission"), Some(id)) => {
                let request = self.next.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut asks) = self.asks.lock() {
                    asks.insert(request, id.clone());
                }
                if let Ok(mut chat) = self.chat.lock() {
                    chat.ask(request, message.get("params").unwrap_or(&Value::Null));
                }
                self.notify();
            }
            // A request for something Retrace doesn't offer (files, terminals, anything newer).
            (Some(method), Some(id)) => {
                let _ = self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } }));
            }
            _ => {}
        }
    }

    fn read_stderr(self: Arc<Self>, mut stderr: impl Read) {
        let mut buf = [0u8; 4096];
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
            // Before the agent answers, this is the setup command talking.
            let shown = self.chat.lock().map(|mut c| c.setup_output(&text)).unwrap_or(false);
            if let Ok(mut tail) = self.stderr.lock() {
                tail.push_str(&text);
                if tail.len() > STDERR_MAX {
                    let mut cut = tail.len() - STDERR_MAX;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
            if shown {
                self.notify();
            }
        }
        self.stream_ended();
    }

    // ---------- opening the conversation ----------

    fn open(self: Arc<Self>, plan: Plan) {
        let outcome = self.open_inner(&plan);
        let task = plan.task.trim();
        let send_task = outcome.is_ok() && plan.open == Open::New && !task.is_empty();
        if let Ok(mut phase) = self.phase.lock() {
            phase.busy = false;
            match &outcome {
                Ok(()) => phase.ready = !phase.closed,
                Err(Failure::Closed) => {}
                Err(failure) => phase.error = Some(failure.text("initialize")),
            }
        }
        if let Err(failure) = &outcome {
            if !matches!(failure, Failure::Closed) {
                let _ = self.chat.lock().map(|mut c| c.error(&failure.text("initialize")));
            }
        }
        if send_task {
            let _ = self.prompt(task);
        }
        self.notify();
    }

    fn open_inner(&self, plan: &Plan) -> Result<(), Failure> {
        let init = self.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "retrace", "title": "Retrace", "version": env!("CARGO_PKG_VERSION") },
            }),
            // The request waits in the pipe while a setup command runs, for as long as that
            // takes (an install can take minutes); the process exiting ends the wait.
            if plan.setup.is_some() { None } else { Some(HANDSHAKE) },
        )?;
        // The agent answered: whatever ran before it has succeeded.
        let _ = self.chat.lock().map(|mut c| c.setup_finished(0));
        self.notify();
        let version = init.get("protocolVersion").and_then(Value::as_u64);
        if version != Some(PROTOCOL) {
            return Err(Failure::Rpc(tr!("这个 agent 说的 ACP 版本 Retrace 不认识：{:?}", "This agent speaks an ACP version Retrace doesn't know: {:?}", version)));
        }
        let cwd = plan.cwd.to_string_lossy().into_owned();
        let wanted = match &plan.open {
            Open::New => None,
            Open::Id(id) => Some(id.clone()),
            Open::Latest => self.latest(&cwd),
        };
        let mut opened = None;
        if let Some(id) = wanted {
            match self.call("session/load", json!({ "sessionId": id, "cwd": cwd, "mcpServers": [] }), Some(OPEN)) {
                Ok(result) => opened = Some((id, result)),
                Err(Failure::Closed) => return Err(Failure::Closed),
                // Say why the history isn't here, then go on with a fresh conversation.
                Err(failure) => {
                    let reason = failure.text("session/load");
                    let _ = self.chat.lock().map(|mut c| c.error(&tr!("没能载入之前的对话，这是一段新的：{reason}", "Couldn't load the earlier conversation, so this is a new one: {reason}")));
                }
            }
        }
        let (id, result) = match opened {
            Some(opened) => opened,
            None => {
                let result = self.call("session/new", json!({ "cwd": cwd, "mcpServers": [] }), Some(OPEN))?;
                let id = result.get("sessionId").and_then(Value::as_str).ok_or_else(|| Failure::Rpc(tr!("agent 没有给出会话 id", "The agent didn't return a session id")))?.to_string();
                (id, result)
            }
        };
        if let Ok(mut phase) = self.phase.lock() {
            phase.session = Some(id.clone());
        }
        if let Some(options) = result.get("configOptions") {
            let _ = self.chat.lock().map(|mut c| c.set_options(options));
        }
        self.notify();
        for (option, value) in &plan.options {
            // A choice the agent no longer offers is simply not applied.
            let _ = self.apply_option(&id, option, value);
        }
        Ok(())
    }

    /// The most recent conversation the agent has for this folder.
    fn latest(&self, cwd: &str) -> Option<String> {
        let listed = self.call("session/list", json!({ "cwd": cwd }), Some(SHORT)).ok()?;
        let here = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
        listed.get("sessions")?.as_array()?.iter().find_map(|s| {
            let at = s.get("cwd").and_then(Value::as_str)?;
            let same = Path::new(at) == here || std::fs::canonicalize(at).is_ok_and(|p| p == here);
            same.then(|| s.get("sessionId").and_then(Value::as_str).map(str::to_string)).flatten()
        })
    }

    /// Set a config option when the agent has it, offers this value and isn't on it already.
    fn apply_option(&self, session: &str, option: &str, value: &str) -> Result<(), Failure> {
        let wanted = self.chat.lock().map(|c| c.options().iter().any(|o| o.id == option && o.value != value && o.choices.iter().any(|c| c.value == value))).unwrap_or(false);
        if !wanted {
            return Ok(());
        }
        let result = self.call("session/set_config_option", json!({ "sessionId": session, "configId": option, "value": value }), Some(SHORT))?;
        if let Some(options) = result.get("configOptions") {
            let _ = self.chat.lock().map(|mut c| c.set_options(options));
        }
        self.notify();
        Ok(())
    }

    // ---------- what the user does ----------

    fn session(&self) -> Result<String> {
        let phase = self.phase.lock().map_err(|_| anyhow!("conversation"))?;
        if phase.closed {
            bail!(tr!("会话已经结束", "The session has ended"));
        }
        match (&phase.session, phase.ready) {
            (Some(id), true) => Ok(id.clone()),
            _ => bail!(tr!("agent 还没准备好", "The agent isn't ready yet")),
        }
    }

    /// Send a message; the turn runs in the background.
    pub fn prompt(self: &Arc<Self>, text: &str) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            bail!(tr!("消息是空的", "The message is empty"));
        }
        let session = self.session()?;
        {
            let mut phase = self.phase.lock().map_err(|_| anyhow!("conversation"))?;
            if phase.busy {
                bail!(tr!("agent 还在忙，先停止这一轮再发", "The agent is still working; stop this turn before sending"));
            }
            phase.busy = true;
            phase.worked = true;
            phase.error = None;
        }
        let _ = self.chat.lock().map(|mut c| c.user(text));
        self.notify();
        let (me, text) = (self.clone(), text.to_string());
        std::thread::spawn(move || {
            let outcome = me.call("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }), None);
            me.dismiss_asks();
            let error = match &outcome {
                Ok(result) => {
                    let reason = result.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
                    let _ = me.chat.lock().map(|mut c| c.end(reason));
                    None
                }
                Err(Failure::Closed) => None,
                Err(failure) => {
                    let message = failure.text("session/prompt");
                    let _ = me.chat.lock().map(|mut c| {
                        c.error(&message);
                        c.end("error");
                    });
                    Some(message)
                }
            };
            if let Ok(mut phase) = me.phase.lock() {
                phase.busy = false;
                phase.error = error;
            }
            me.notify();
            me.refresh_title(&session);
        });
        Ok(())
    }

    /// The agent's own name for the conversation, once it has one.
    fn refresh_title(&self, session: &str) {
        let Ok(listed) = self.call("session/list", json!({ "cwd": self.cwd.to_string_lossy() }), Some(SHORT)) else { return };
        let title = listed
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session))
            .and_then(|s| s.get("title").and_then(Value::as_str))
            .map(str::to_string);
        let changed = self.phase.lock().map(|mut p| title.is_some() && std::mem::replace(&mut p.title, title.clone()) != title).unwrap_or(false);
        if changed {
            self.notify();
        }
    }

    /// Stop the turn in progress. Requests still waiting for the user are answered "cancelled",
    /// as the protocol asks.
    pub fn cancel(&self) -> Result<()> {
        let session = self.session()?;
        self.dismiss_asks();
        self.send(&json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } })).map_err(|f| anyhow!(f.text("session/cancel")))?;
        self.notify();
        Ok(())
    }

    fn dismiss_asks(&self) {
        let asks: Vec<(u64, Value)> = self.asks.lock().map(|mut a| a.drain().collect()).unwrap_or_default();
        for (request, id) in asks {
            let _ = self.chat.lock().map(|mut c| c.answer(request, "cancelled"));
            let _ = self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "cancelled" } } }));
        }
    }

    /// The user's answer to a permission request: one of the options the agent offered.
    pub fn answer(&self, request: u64, option: &str) -> Result<()> {
        if !self.chat.lock().map(|c| c.offers(request, option)).unwrap_or(false) {
            bail!(tr!("这个请求已经回答过了", "This request has already been answered"));
        }
        let id = self.asks.lock().ok().and_then(|mut a| a.remove(&request)).ok_or_else(|| anyhow!(tr!("这个请求已经回答过了", "This request has already been answered")))?;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "selected", "optionId": option } } })).map_err(|f| anyhow!(f.text("session/request_permission")))?;
        let _ = self.chat.lock().map(|mut c| c.answer(request, option));
        self.notify();
        Ok(())
    }

    pub fn set_option(&self, option: &str, value: &str) -> Result<()> {
        let session = self.session()?;
        let known = self.chat.lock().map(|c| c.options().iter().any(|o| o.id == option && o.choices.iter().any(|c| c.value == value))).unwrap_or(false);
        if !known {
            bail!(tr!("agent 没有这个选项：{option} = {value}", "The agent doesn't offer this: {option} = {value}"));
        }
        self.apply_option(&session, option, value).map_err(|f| anyhow!(f.text("session/set_config_option")))
    }

    // ---------- what the rest of Retrace reads ----------

    pub fn transcript(&self, after: u64) -> Result<Transcript> {
        let chat = self.chat.lock().map_err(|_| anyhow!("conversation"))?;
        Ok(Transcript { rev: chat.rev(), items: chat.since(after), options: chat.options().to_vec(), usage: chat.usage() })
    }

    pub fn native_id(&self) -> Option<String> {
        self.phase.lock().ok().and_then(|p| p.session.clone())
    }

    pub fn title(&self) -> Option<String> {
        self.phase.lock().ok().and_then(|p| p.title.clone())
    }

    /// The session's state for the projects list: a waiting request first, then a turn in progress.
    pub fn live(&self) -> Live {
        let asking = self.chat.lock().ok().and_then(|c| c.waiting().into_iter().next());
        let mut phase = match self.phase.lock() {
            Ok(phase) => phase,
            Err(_) => return Live { state: LiveState::Idle, detail: None, worked: false, since: self.started, at: self.started },
        };
        let (state, detail) = match (asking, phase.busy, &phase.error) {
            (Some((_, detail)), _, _) => (LiveState::Asking, Some(detail)),
            (None, true, _) => (LiveState::Busy, None),
            (None, false, Some(error)) => (LiveState::Error, Some(error.clone())),
            (None, false, None) => (LiveState::Idle, None),
        };
        let at = match &phase.shown {
            Some((s, d, at)) if *s == state && *d == detail => *at,
            _ => now_ms(),
        };
        phase.shown = Some((state, detail.clone(), at));
        Live { state, detail, worked: phase.worked, since: self.started, at }
    }

    /// The process is gone. `stopped`: because the user ended it.
    pub fn exited(&self, code: i32, stopped: bool) {
        // What it wrote last (an answer, the setup command's error) may still be in the pipes:
        // let the readers finish first. Something it started can hold a pipe open, so not forever.
        if let Ok(done) = self.drained.0.lock() {
            let _ = self.drained.1.wait_timeout_while(done, DRAIN, |done| *done < 2);
        }
        if let Ok(mut phase) = self.phase.lock() {
            phase.closed = true;
            phase.ready = false;
            phase.busy = false;
        }
        let _ = self.stdin.lock().map(|mut s| s.take());
        // Something the agent started may still hold its output open: nobody will answer now.
        let waiting: Vec<Reply> = self.pending.lock().map(|mut p| p.drain().map(|(_, tx)| tx).collect()).unwrap_or_default();
        for tx in waiting {
            let _ = tx.send(Err(Failure::Closed));
        }
        let tail = self.stderr.lock().map(|t| t.trim().to_string()).unwrap_or_default();
        if let Ok(mut chat) = self.chat.lock() {
            // Still in the setup command: its exit code is the story, its output is already shown.
            let in_setup = chat.since(0).iter().any(|i| matches!(i.body, super::chat::Body::Setup { code: None, .. }));
            chat.setup_finished(code);
            if !stopped && code != 0 && !in_setup && !tail.is_empty() {
                chat.error(&tail);
            }
        }
        self.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_reads_as_the_agent_worded_it() {
        assert_eq!(rpc_message(&json!({ "code": -32603, "message": "Internal error: insufficient balance (1008)" })), "insufficient balance (1008)");
        assert_eq!(rpc_message(&json!({ "code": -32000, "message": "Authentication required" })), "Authentication required");
        assert!(!rpc_message(&json!({})).is_empty());
    }
}
