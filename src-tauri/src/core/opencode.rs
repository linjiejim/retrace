//! OpenCode's own word on what a session is doing. Judging from terminal output can't tell a
//! long-running command from a permission prompt (OpenCode keeps animating through both), so
//! sessions Retrace starts load a small plugin (`opencode_plugin.js`) that appends the events
//! Retrace needs to a file: busy or idle, a permission or a question waiting for the user, the
//! last error, and which conversation is open (so exactly that one can be reopened later).
//!
//! One-way and local: a file only Retrace reads. No port, nothing sent to OpenCode; everything
//! the user does still goes through the terminal. The plugin is added through
//! `OPENCODE_CONFIG_CONTENT` for that one process and never touches the user's OpenCode config.

use super::agent::{now_ms, Live, LiveState, Sessions};
use super::shell_env::Env;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const PLUGIN: &str = include_str!("opencode_plugin.js");
const EVENTS_VAR: &str = "RETRACE_AGENT_EVENTS";
const CONFIG_VAR: &str = "OPENCODE_CONFIG_CONTENT";
/// Feeds and plugin copies left by sessions that didn't end cleanly are swept after this long.
const STALE: Duration = Duration::from_secs(7 * 24 * 3600);

/// Where one OpenCode session writes its events.
#[derive(Debug, Clone)]
pub struct Feed {
    pub events: PathBuf,
}

/// Transient files: next to a sandboxed config when there is one, else the user's cache folder.
fn feed_dir() -> PathBuf {
    match std::env::var("RETRACE_CONFIG_DIR") {
        Ok(dir) => PathBuf::from(dir).join("agents"),
        Err(_) => dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("me.jimlin.retrace").join("agents"),
    }
}

fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

/// `file://` URL for a path: everything but unreserved characters and `/` is percent-encoded.
fn file_url(path: &Path) -> String {
    let mut url = String::from("file://");
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            url.push(b as char);
        } else {
            url.push_str(&format!("%{b:02X}"));
        }
    }
    url
}

fn private_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(path)
}

impl Feed {
    /// Make OpenCode started with `env` write its events to a new file. None when that can't be
    /// set up (or the user's own inline config isn't something to add to): the session then
    /// runs without it, judged by its terminal output like the other agents.
    pub fn prepare(env: &mut Env) -> Option<Self> {
        Self::prepare_in(&feed_dir(), env)
    }

    pub fn prepare_in(dir: &Path, env: &mut Env) -> Option<Self> {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).ok()?;
        sweep(dir);
        // Named by content: an older Retrace still running keeps its own copy.
        let plugin = dir.join(format!("opencode-plugin-{:016x}.js", fnv(PLUGIN)));
        if std::fs::read_to_string(&plugin).ok().as_deref() != Some(PLUGIN) {
            let tmp = dir.join(format!("opencode-plugin.{}.tmp", std::process::id()));
            let _ = std::fs::remove_file(&tmp);
            private_file(&tmp).and_then(|mut f| f.write_all(PLUGIN.as_bytes())).ok()?;
            std::fs::rename(&tmp, &plugin).ok()?;
        }
        let config = with_plugin(env.get(CONFIG_VAR).map(String::as_str), &file_url(&plugin))?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let events = dir.join(format!("feed-{}-{:x}-{}.jsonl", std::process::id(), now_ms(), NEXT.fetch_add(1, Ordering::Relaxed)));
        private_file(&events).ok()?;
        env.insert(CONFIG_VAR.into(), config);
        env.insert(EVENTS_VAR.into(), events.to_string_lossy().into_owned());
        Some(Self { events })
    }
}

/// The inline OpenCode config with our plugin added to whatever the user already passes that
/// way (OpenCode merges plugin lists across its config sources). None when theirs isn't a JSON
/// object: it is left alone.
pub fn with_plugin(existing: Option<&str>, plugin: &str) -> Option<String> {
    let mut config = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => serde_json::from_str::<Value>(text).ok().filter(Value::is_object)?,
        None => json!({}),
    };
    let list = config.as_object_mut()?.entry("plugin").or_insert_with(|| json!([]));
    list.as_array_mut()?.push(json!(plugin));
    Some(config.to_string())
}

fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = (name.starts_with("feed-") && name.ends_with(".jsonl")) || (name.starts_with("opencode-plugin") && (name.ends_with(".js") || name.ends_with(".tmp")));
        let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|at| SystemTime::now().duration_since(at).is_ok_and(|age| age > STALE));
        if ours && old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------- what the events add up to ----------

/// The state of one OpenCode terminal, from its events. No I/O, so it is unit-tested with the
/// payloads OpenCode really sends.
#[derive(Default)]
pub struct Tracker {
    /// The plugin is loaded: from here on, silence means idle.
    ready: bool,
    /// Conversations with a turn in progress (subagents count: their parent waits for them).
    busy: BTreeSet<String>,
    /// Conversations started by another one (subagents); never the one to reopen.
    children: BTreeSet<String>,
    /// Permissions and questions waiting for the user: request id, conversation, what it is about.
    asks: Vec<(String, String, Option<String>)>,
    /// The last turn failed with this.
    error: Option<String>,
    /// The conversation the terminal shows: the one to reopen.
    pub current: Option<String>,
    /// A turn has run since Retrace started following.
    worked: bool,
}

const DETAIL_MAX: usize = 300;

fn clip(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > DETAIL_MAX {
        format!("{}…", one_line.chars().take(DETAIL_MAX - 1).collect::<String>())
    } else {
        one_line
    }
}

impl Tracker {
    pub fn apply(&mut self, event: &Value) {
        let kind = event["type"].as_str().unwrap_or("");
        let p = &event["properties"];
        let session = p["sessionID"].as_str().or_else(|| p["info"]["id"].as_str());
        match kind {
            "retrace.ready" => self.ready = true,
            "session.created" => {
                let Some(id) = session else { return };
                if p["info"]["parentID"].is_string() {
                    self.children.insert(id.to_string());
                } else {
                    self.current = Some(id.to_string());
                }
            }
            "session.status" => {
                let Some(id) = session else { return };
                if p["status"]["type"].as_str() == Some("idle") {
                    self.idle(id);
                } else {
                    self.busy.insert(id.to_string());
                    self.worked = true;
                    // A new turn: the last one's error is history.
                    self.error = None;
                    if !self.children.contains(id) {
                        self.current = Some(id.to_string());
                    }
                }
            }
            "session.idle" => {
                if let Some(id) = session {
                    self.idle(id);
                }
            }
            "session.error" => {
                let name = p["error"]["name"].as_str().unwrap_or("");
                // The user pressed Esc: not a failure.
                if name != "MessageAbortedError" {
                    let message = p["error"]["data"]["message"].as_str().filter(|m| !m.trim().is_empty()).unwrap_or(name);
                    self.error = Some(clip(message)).filter(|m| !m.is_empty());
                }
            }
            "session.deleted" => {
                if let Some(id) = session {
                    self.idle(id);
                    if self.current.as_deref() == Some(id) {
                        self.current = None;
                    }
                }
            }
            "tui.session.select" => {
                if let Some(id) = session {
                    self.current = Some(id.to_string());
                }
            }
            _ if kind.starts_with("permission.") || kind.starts_with("question.") => {
                if kind.ends_with(".asked") {
                    let Some(id) = p["id"].as_str() else { return };
                    let detail = if kind.starts_with("permission.") {
                        let what = p["permission"].as_str().unwrap_or("");
                        let patterns: Vec<&str> = p["patterns"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                        Some(if patterns.is_empty() { what.to_string() } else { format!("{what}: {}", patterns.join(", ")) })
                    } else {
                        p["questions"][0]["question"].as_str().map(str::to_string)
                    };
                    self.asks.retain(|(known, _, _)| known != id);
                    self.asks.push((id.to_string(), session.unwrap_or("").to_string(), detail.map(|d| clip(&d)).filter(|d| !d.is_empty())));
                } else {
                    // Replied or rejected.
                    let id = p["requestID"].as_str().or_else(|| p["id"].as_str());
                    self.asks.retain(|(known, _, _)| Some(known.as_str()) != id);
                }
            }
            _ => {}
        }
    }

    /// The turn is over: nothing of that conversation can still be waiting for an answer.
    fn idle(&mut self, id: &str) {
        self.busy.remove(id);
        self.asks.retain(|(_, session, _)| session != id);
    }

    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn state(&self) -> (LiveState, Option<String>) {
        if let Some((_, _, detail)) = self.asks.first() {
            (LiveState::Asking, detail.clone())
        } else if !self.busy.is_empty() {
            (LiveState::Busy, None)
        } else if let Some(error) = &self.error {
            (LiveState::Error, Some(error.clone()))
        } else {
            (LiveState::Idle, None)
        }
    }

    pub fn worked(&self) -> bool {
        self.worked
    }
}

// ---------- following one session ----------

/// New complete lines of a file that something else appends to.
struct Tail {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl Tail {
    fn read(&mut self) -> Vec<Value> {
        let Ok(len) = std::fs::metadata(&self.path).map(|m| m.len()) else { return vec![] };
        if len < self.offset {
            // Replaced by a new file (the old one was cleared away): start over.
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset {
            return vec![];
        }
        let mut fresh = Vec::new();
        let read = std::fs::File::open(&self.path).and_then(|mut f| {
            f.seek(SeekFrom::Start(self.offset))?;
            f.take(len - self.offset).read_to_end(&mut fresh)
        });
        let Ok(n) = read else { return vec![] };
        self.offset += n as u64;
        self.partial.extend_from_slice(&fresh);
        let Some(end) = self.partial.iter().rposition(|b| *b == b'\n') else { return vec![] };
        let lines: Vec<u8> = self.partial.drain(..=end).collect();
        lines.split(|b| *b == b'\n').filter_map(|line| serde_json::from_slice(line).ok()).collect()
    }
}

/// Keep `id`'s live state in step with its OpenCode until the session ends. Until the plugin
/// says it is loaded (it never does in an OpenCode too old for it) there is no live state and
/// the UI goes by the terminal's output.
pub fn watch(sessions: Arc<Sessions>, id: String, feed: Feed) {
    std::thread::spawn(move || {
        let mut tail = Tail { path: feed.events.clone(), offset: 0, partial: Vec::new() };
        let mut tracker = Tracker::default();
        let mut since = 0;
        let mut last: Option<(LiveState, Option<String>, bool)> = None;
        let mut native: Option<String> = None;
        while sessions.is_running(&id) {
            let events = tail.read();
            for event in &events {
                tracker.apply(event);
            }
            if tracker.ready() && (!events.is_empty() || last.is_none()) {
                if since == 0 {
                    since = now_ms();
                }
                let (state, detail) = tracker.state();
                let now = (state, detail, tracker.worked());
                let native_changed = tracker.current.is_some() && tracker.current != native;
                if native_changed {
                    native = tracker.current.clone();
                }
                if native_changed || last.as_ref() != Some(&now) {
                    let live = Live { state: now.0, detail: now.1.clone(), worked: now.2, since, at: now_ms() };
                    sessions.report(&id, native.clone().filter(|_| native_changed), Some(live));
                    last = Some(now);
                }
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let _ = std::fs::remove_file(&feed.events);
    });
}

// ---------- finding a conversation to reopen ----------

/// The conversation OpenCode last touched in `tree`, for a session saved before Retrace knew
/// its id. All worktrees of a repository share one OpenCode project, so match the folder.
pub fn last_session(bin: &Path, tree: &Path, env: &Env) -> Option<String> {
    let mut child = Command::new(bin)
        .args(["session", "list", "--format", "json", "-n", "50"])
        .current_dir(tree)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + Duration::from_secs(10);
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
    pick_session(&reader.join().ok()?, tree)
}

/// From `opencode session list --format json`: the most recently updated one whose folder is `tree`.
pub fn pick_session(listing: &[u8], tree: &Path) -> Option<String> {
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let tree = real(tree);
    let list: Vec<Value> = serde_json::from_slice(listing).ok()?;
    list.iter()
        .filter(|s| s["directory"].as_str().is_some_and(|d| real(Path::new(d)) == tree))
        .max_by_key(|s| s["updated"].as_i64().unwrap_or(0))
        .and_then(|s| s["id"].as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: &str, kind: &str) -> Value {
        json!({ "type": "session.status", "properties": { "sessionID": id, "status": { "type": kind } } })
    }

    fn asked(kind: &str, id: &str, session: &str, more: Value) -> Value {
        let mut p = json!({ "id": id, "sessionID": session });
        p.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        json!({ "type": format!("{kind}.asked"), "properties": p })
    }

    #[test]
    fn a_turn_is_busy_then_idle_and_names_the_conversation() {
        let mut t = Tracker::default();
        assert!(!t.ready());
        t.apply(&json!({ "type": "retrace.ready" }));
        assert!(t.ready());
        assert_eq!(t.state(), (LiveState::Idle, None));
        assert!(!t.worked());
        t.apply(&json!({ "type": "session.created", "properties": { "sessionID": "ses_a", "info": { "id": "ses_a", "parentID": null } } }));
        assert_eq!(t.current.as_deref(), Some("ses_a"));
        t.apply(&status("ses_a", "busy"));
        assert_eq!(t.state(), (LiveState::Busy, None));
        assert!(t.worked());
        t.apply(&status("ses_a", "idle"));
        t.apply(&json!({ "type": "session.idle", "properties": { "sessionID": "ses_a" } }));
        assert_eq!(t.state(), (LiveState::Idle, None));
        // A retry is still a turn in progress.
        t.apply(&status("ses_a", "retry"));
        assert_eq!(t.state().0, LiveState::Busy);
    }

    #[test]
    fn a_pending_permission_or_question_wins_over_busy() {
        let mut t = Tracker::default();
        t.apply(&status("ses_a", "busy"));
        // OpenCode stays busy while it waits for the answer.
        t.apply(&asked("permission", "per_1", "ses_a", json!({ "permission": "bash", "patterns": ["ls", "pwd"] })));
        assert_eq!(t.state(), (LiveState::Asking, Some("bash: ls, pwd".into())));
        t.apply(&asked("question", "que_1", "ses_a", json!({ "questions": [{ "question": "Which\n  database?" }] })));
        // The first one asked is the one shown.
        assert_eq!(t.state().1.as_deref(), Some("bash: ls, pwd"));
        t.apply(&json!({ "type": "permission.replied", "properties": { "sessionID": "ses_a", "requestID": "per_1", "reply": "once" } }));
        assert_eq!(t.state(), (LiveState::Asking, Some("Which database?".into())));
        t.apply(&json!({ "type": "question.rejected", "properties": { "sessionID": "ses_a", "requestID": "que_1" } }));
        assert_eq!(t.state(), (LiveState::Busy, None));
        // A reply that never arrived can't outlive the turn.
        t.apply(&asked("permission", "per_2", "ses_a", json!({ "permission": "edit" })));
        assert_eq!(t.state(), (LiveState::Asking, Some("edit".into())));
        t.apply(&status("ses_a", "idle"));
        assert_eq!(t.state(), (LiveState::Idle, None));
    }

    #[test]
    fn a_failed_turn_shows_its_error_until_the_next_turn() {
        let mut t = Tracker::default();
        t.apply(&status("ses_a", "busy"));
        t.apply(&json!({ "type": "session.error", "properties": { "sessionID": "ses_a", "error": { "name": "APIError", "data": { "message": "insufficient balance (1008)" } } } }));
        // Still busy for a moment: the error shows once the turn is over.
        assert_eq!(t.state().0, LiveState::Busy);
        t.apply(&status("ses_a", "idle"));
        assert_eq!(t.state(), (LiveState::Error, Some("insufficient balance (1008)".into())));
        t.apply(&status("ses_a", "busy"));
        assert_eq!(t.state(), (LiveState::Busy, None));
        // Esc is the user's doing.
        t.apply(&json!({ "type": "session.error", "properties": { "sessionID": "ses_a", "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } } } }));
        t.apply(&status("ses_a", "idle"));
        assert_eq!(t.state(), (LiveState::Idle, None));
        // No message: the error's name is better than nothing.
        t.apply(&json!({ "type": "session.error", "properties": { "error": { "name": "UnknownError", "data": {} } } }));
        assert_eq!(t.state(), (LiveState::Error, Some("UnknownError".into())));
    }

    #[test]
    fn subagents_keep_it_busy_but_are_never_the_conversation_to_reopen() {
        let mut t = Tracker::default();
        t.apply(&json!({ "type": "session.created", "properties": { "sessionID": "ses_a", "info": { "id": "ses_a", "parentID": null } } }));
        t.apply(&json!({ "type": "session.created", "properties": { "sessionID": "ses_child", "info": { "id": "ses_child", "parentID": "ses_a" } } }));
        t.apply(&status("ses_child", "busy"));
        assert_eq!(t.current.as_deref(), Some("ses_a"));
        assert_eq!(t.state().0, LiveState::Busy);
        // Switching conversations in the terminal follows.
        t.apply(&json!({ "type": "tui.session.select", "properties": { "sessionID": "ses_b" } }));
        assert_eq!(t.current.as_deref(), Some("ses_b"));
        t.apply(&json!({ "type": "session.deleted", "properties": { "sessionID": "ses_b", "info": { "id": "ses_b", "parentID": null } } }));
        assert_eq!(t.current, None);
    }

    #[test]
    fn the_conversation_to_reopen_is_the_latest_in_this_folder() {
        let dir = std::env::temp_dir();
        let here = dir.to_string_lossy();
        let listing = json!([
            { "id": "ses_old", "updated": 10, "directory": here },
            { "id": "ses_new", "updated": 30, "directory": here },
            { "id": "ses_elsewhere", "updated": 99, "directory": "/somewhere/else" },
        ]);
        assert_eq!(pick_session(listing.to_string().as_bytes(), &dir).as_deref(), Some("ses_new"));
        assert_eq!(pick_session(b"[]", &dir), None);
        assert_eq!(pick_session(b"not json", &dir), None);
    }

    #[test]
    fn the_plugin_joins_the_users_inline_config_or_leaves_it_alone() {
        assert_eq!(with_plugin(None, "file:///p.js").unwrap(), r#"{"plugin":["file:///p.js"]}"#);
        let merged: Value = serde_json::from_str(&with_plugin(Some(r#"{"model":"a/b","plugin":["theirs"]}"#), "file:///p.js").unwrap()).unwrap();
        assert_eq!(merged, json!({ "model": "a/b", "plugin": ["theirs", "file:///p.js"] }));
        // Not something to add to: the session runs without the feed rather than with a broken config.
        assert_eq!(with_plugin(Some("not json"), "file:///p.js"), None);
        assert_eq!(with_plugin(Some(r#"{"plugin":"one"}"#), "file:///p.js"), None);
        assert_eq!(file_url(Path::new("/Users/a b/Library/Application Support/x.js")), "file:///Users/a%20b/Library/Application%20Support/x.js");
    }

    #[test]
    fn a_feed_is_a_private_file_the_tail_follows_across_partial_lines() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("retrace-feed-test-{}-{}", std::process::id(), now_ms()));
        let mut env = Env::new();
        let feed = Feed::prepare_in(&dir, &mut env).unwrap();
        assert_eq!(env[EVENTS_VAR], feed.events.to_string_lossy());
        let config: Value = serde_json::from_str(&env[CONFIG_VAR]).unwrap();
        let plugin = config["plugin"][0].as_str().unwrap().strip_prefix("file://").unwrap().to_string();
        assert_eq!(std::fs::read_to_string(&plugin).unwrap(), PLUGIN);
        assert_eq!(std::fs::metadata(&feed.events).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        // A second session gets its own file and the same plugin.
        let other = Feed::prepare_in(&dir, &mut Env::new()).unwrap();
        assert_ne!(other.events, feed.events);

        let mut tail = Tail { path: feed.events.clone(), offset: 0, partial: Vec::new() };
        assert!(tail.read().is_empty());
        let mut file = std::fs::OpenOptions::new().append(true).open(&feed.events).unwrap();
        file.write_all(b"{\"type\":\"a\"}\n{\"type\":").unwrap();
        assert_eq!(tail.read(), vec![json!({ "type": "a" })]);
        file.write_all(b"\"b\"}\nnot json\n").unwrap();
        assert_eq!(tail.read(), vec![json!({ "type": "b" })]);
        // Cleared away and written again: read from the top.
        std::fs::write(&feed.events, b"{\"type\":\"c\"}\n").unwrap();
        assert_eq!(tail.read(), vec![json!({ "type": "c" })]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
