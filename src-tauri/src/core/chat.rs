//! A conversation with an agent, as Retrace shows it: what the agent sends over ACP (see
//! `acp.rs`) folded into a short list of records. Nothing here does I/O.
//!
//! Records live in memory only. The agent keeps the history; reopening a conversation replays it.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The end of a command's output kept in its record.
const OUTPUT_MAX: usize = 8 * 1024;
/// The setup command's output kept.
const SETUP_MAX: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    /// Relative to the session's worktree when inside it.
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanEntry {
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AskOption {
    pub id: String,
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always`.
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Body {
    /// The project's setup command, run before the agent starts. `code`: none while it runs.
    Setup { command: String, output: String, code: Option<i32> },
    User { text: String },
    /// The agent's answer (Markdown).
    Message { text: String },
    Thought { text: String },
    Tool {
        /// `read`, `edit`, `execute`, `search`, `fetch`, `other`, …
        tool: String,
        title: String,
        /// `pending`, `in_progress`, `completed`, `failed`.
        status: String,
        paths: Vec<String>,
        command: Option<String>,
        output: Option<String>,
        diffs: Vec<DiffStat>,
    },
    Plan { entries: Vec<PlanEntry> },
    /// A permission the agent waits for. `answer`: none while it waits, then the chosen option's
    /// id, or `cancelled`.
    Ask { request: u64, title: String, tool: String, command: Option<String>, paths: Vec<String>, options: Vec<AskOption>, answer: Option<String> },
    Error { text: String },
    /// A turn ended: `end_turn`, `cancelled`, `max_tokens`, `refusal`, …
    End { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub id: u64,
    /// The conversation's revision when this record last changed.
    pub rev: u64,
    #[serde(flatten)]
    pub body: Body,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    pub group: Option<String>,
}

/// Something the agent lets the user choose (model, mode, effort): Retrace shows whatever is here.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    /// `model`, `mode`, `thought_level`, …
    pub category: Option<String>,
    pub value: String,
    pub choices: Vec<Choice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Usage {
    /// Tokens of context in use, and the model's window.
    pub used: u64,
    pub size: u64,
}

struct Entry {
    item: Item,
    /// The agent's id for what this record is made of (a message or a tool call).
    key: Option<String>,
}

pub struct Chat {
    entries: Vec<Entry>,
    rev: u64,
    options: Vec<ConfigOption>,
    usage: Option<Usage>,
    /// The session's worktree, as given and with symlinks resolved: paths under it are shown relative.
    roots: Vec<PathBuf>,
}

fn text_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Keep the end of `text`, on a character boundary.
fn tail(text: &mut String, max: usize) {
    if text.len() <= max {
        return;
    }
    let mut cut = text.len() - max;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    text.drain(..cut);
}

/// Lines added and removed going from `old` to `new` (longest common subsequence of lines).
pub fn line_stats(old: &str, new: &str) -> (usize, usize) {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let head = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[head..], &b[head..]);
    let foot = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[..a.len() - foot], &b[..b.len() - foot]);
    // Too large to compare line by line: count the whole differing block.
    if a.is_empty() || b.is_empty() || a.len().saturating_mul(b.len()) > 4_000_000 {
        return (b.len(), a.len());
    }
    let mut row = vec![0u32; b.len() + 1];
    for x in a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y { diagonal + 1 } else { above.max(row[j]) };
            diagonal = above;
        }
    }
    let common = row[b.len()] as usize;
    (b.len() - common, a.len() - common)
}

impl Chat {
    pub fn new(root: &Path) -> Self {
        let mut roots = vec![root.to_path_buf()];
        if let Ok(real) = std::fs::canonicalize(root) {
            if real != root {
                roots.push(real);
            }
        }
        Self { entries: Vec::new(), rev: 0, options: Vec::new(), usage: None, roots }
    }

    fn relative(&self, path: &str) -> String {
        let p = Path::new(path);
        self.roots.iter().find_map(|root| p.strip_prefix(root).ok()).filter(|rest| !rest.as_os_str().is_empty()).map(|rest| rest.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
    }

    /// Paths to show for a step: relative, and without the worktree itself (a command's working
    /// directory says nothing).
    fn shown(&self, paths: &[String]) -> Vec<String> {
        paths.iter().filter(|p| !self.roots.iter().any(|root| Path::new(p.as_str()) == root)).map(|p| self.relative(p)).collect()
    }

    fn push(&mut self, body: Body, key: Option<String>) -> usize {
        self.rev += 1;
        let id = self.entries.len() as u64 + 1;
        self.entries.push(Entry { item: Item { id, rev: self.rev, body }, key });
        self.entries.len() - 1
    }

    fn touch(&mut self, index: usize) {
        self.rev += 1;
        self.entries[index].item.rev = self.rev;
    }

    pub fn rev(&self) -> u64 {
        self.rev
    }

    /// Records changed after revision `after`, oldest first.
    pub fn since(&self, after: u64) -> Vec<Item> {
        self.entries.iter().filter(|e| e.item.rev > after).map(|e| e.item.clone()).collect()
    }

    pub fn options(&self) -> &[ConfigOption] {
        &self.options
    }

    pub fn usage(&self) -> Option<Usage> {
        self.usage
    }

    // ---------- what Retrace itself adds ----------

    pub fn user(&mut self, text: &str) {
        self.push(Body::User { text: text.to_string() }, None);
    }

    pub fn error(&mut self, text: &str) {
        self.push(Body::Error { text: text.to_string() }, None);
    }

    /// The turn is over; tool calls it left unfinished didn't happen.
    pub fn end(&mut self, reason: &str) {
        for i in 0..self.entries.len() {
            if let Body::Tool { status, .. } = &mut self.entries[i].item.body {
                if status == "pending" || status == "in_progress" {
                    *status = "cancelled".into();
                    self.touch(i);
                }
            }
        }
        self.push(Body::End { reason: reason.to_string() }, None);
    }

    pub fn setup_started(&mut self, command: &str) {
        self.push(Body::Setup { command: command.to_string(), output: String::new(), code: None }, None);
    }

    fn setup(&mut self) -> Option<usize> {
        self.entries.iter().position(|e| matches!(e.item.body, Body::Setup { code: None, .. }))
    }

    /// Output of the setup command while it runs; false once it is over.
    pub fn setup_output(&mut self, text: &str) -> bool {
        let Some(i) = self.setup() else { return false };
        if let Body::Setup { output, .. } = &mut self.entries[i].item.body {
            output.push_str(text);
            tail(output, SETUP_MAX);
        }
        self.touch(i);
        true
    }

    pub fn setup_finished(&mut self, exit: i32) {
        let Some(i) = self.setup() else { return };
        if let Body::Setup { code, .. } = &mut self.entries[i].item.body {
            *code = Some(exit);
        }
        self.touch(i);
    }

    // ---------- what the agent sends ----------

    /// `configOptions` from the agent: only the ones a user picks from a list.
    pub fn set_options(&mut self, options: &Value) {
        let Some(list) = options.as_array() else { return };
        let mut out = Vec::new();
        for o in list {
            let (Some(id), Some(value)) = (text_of(o, "id"), text_of(o, "currentValue")) else { continue };
            if o.get("type").and_then(Value::as_str).is_some_and(|t| t != "select") {
                continue;
            }
            let mut choices = Vec::new();
            for c in o.get("options").and_then(Value::as_array).into_iter().flatten() {
                // Either a choice, or a named group of them.
                match c.get("options").and_then(Value::as_array) {
                    Some(inner) => {
                        let group = text_of(c, "name").or_else(|| text_of(c, "group"));
                        choices.extend(inner.iter().filter_map(|c| choice(c, group.clone())));
                    }
                    None => choices.extend(choice(c, None)),
                }
            }
            out.push(ConfigOption { name: text_of(o, "name").unwrap_or_else(|| id.clone()), id, category: text_of(o, "category"), value, choices });
        }
        if out != self.options {
            self.options = out;
            self.rev += 1;
        }
    }

    /// One `session/update` from the agent.
    pub fn apply(&mut self, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        match kind {
            "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
                let Some(text) = update.get("content").filter(|c| c.get("type").and_then(Value::as_str) == Some("text")).and_then(|c| text_of(c, "text")) else { return };
                self.chunk(kind, &text, text_of(update, "messageId"));
            }
            "tool_call" | "tool_call_update" => self.tool(update),
            "plan" => {
                let entries: Vec<PlanEntry> = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| Some(PlanEntry { text: text_of(e, "content")?, status: text_of(e, "status").unwrap_or_else(|| "pending".into()) }))
                    .collect();
                // One plan per turn, replaced as it changes.
                let turn = self.entries.iter().rposition(|e| matches!(e.item.body, Body::User { .. })).map_or(0, |i| i + 1);
                match self.entries[turn..].iter().position(|e| matches!(e.item.body, Body::Plan { .. })) {
                    Some(i) => {
                        self.entries[turn + i].item.body = Body::Plan { entries };
                        self.touch(turn + i);
                    }
                    None => {
                        self.push(Body::Plan { entries }, None);
                    }
                }
            }
            "config_option_update" => {
                if let Some(options) = update.get("configOptions") {
                    self.set_options(options);
                }
            }
            "usage_update" => {
                let (Some(used), Some(size)) = (update.get("used").and_then(Value::as_u64), update.get("size").and_then(Value::as_u64)) else { return };
                let usage = Some(Usage { used, size });
                if usage != self.usage {
                    self.usage = usage;
                    self.rev += 1;
                }
            }
            _ => {}
        }
    }

    fn chunk(&mut self, kind: &str, text: &str, key: Option<String>) {
        if text.is_empty() {
            return;
        }
        // The same message keeps arriving: add to it.
        if let Some(last) = self.entries.last_mut() {
            let same = key.is_none() || last.key.is_none() || key == last.key;
            let body = match (&mut last.item.body, kind) {
                (Body::User { text }, "user_message_chunk") | (Body::Message { text }, "agent_message_chunk") | (Body::Thought { text }, "agent_thought_chunk") if same => Some(text),
                _ => None,
            };
            if let Some(body) = body {
                body.push_str(text);
                let at = self.entries.len() - 1;
                return self.touch(at);
            }
        }
        let body = match kind {
            "user_message_chunk" => Body::User { text: text.to_string() },
            "agent_message_chunk" => Body::Message { text: text.to_string() },
            _ => Body::Thought { text: text.to_string() },
        };
        self.push(body, key);
    }

    fn tool(&mut self, update: &Value) {
        let Some(key) = text_of(update, "toolCallId") else { return };
        let at = match self.entries.iter().rposition(|e| e.key.as_deref() == Some(&key) && matches!(e.item.body, Body::Tool { .. })) {
            Some(at) => at,
            None => self.push(Body::Tool { tool: "other".into(), title: String::new(), status: "pending".into(), paths: vec![], command: None, output: None, diffs: vec![] }, Some(key)),
        };
        let new_paths = locations(update).map(|l| self.shown(&l));
        let mut text = String::new();
        let mut new_diffs = Vec::new();
        for c in update.get("content").and_then(Value::as_array).into_iter().flatten() {
            match c.get("type").and_then(Value::as_str) {
                Some("content") => {
                    if let Some(t) = c.get("content").and_then(|c| text_of(c, "text")) {
                        text.push_str(&t);
                    }
                }
                Some("diff") => {
                    let Some(path) = text_of(c, "path") else { continue };
                    let (added, removed) = line_stats(c.get("oldText").and_then(Value::as_str).unwrap_or(""), c.get("newText").and_then(Value::as_str).unwrap_or(""));
                    new_diffs.push(DiffStat { path: self.relative(&path), added, removed });
                }
                _ => {}
            }
        }
        if text.is_empty() {
            text = update.get("rawOutput").and_then(|o| text_of(o, "output")).unwrap_or_default();
        }
        let Body::Tool { tool, title, status, paths, command, output, diffs } = &mut self.entries[at].item.body else { return };
        if let Some(k) = text_of(update, "kind") {
            *tool = k;
        }
        if let Some(t) = text_of(update, "title").filter(|t| !t.is_empty()) {
            *title = t;
        }
        if let Some(s) = text_of(update, "status") {
            *status = s;
        }
        if let Some(p) = new_paths.filter(|p| !p.is_empty()) {
            *paths = p;
        }
        if let Some(c) = update.get("rawInput").and_then(|i| text_of(i, "command")) {
            *command = Some(c);
        }
        if !text.is_empty() {
            tail(&mut text, OUTPUT_MAX);
            *output = Some(text);
        }
        if !new_diffs.is_empty() {
            *diffs = new_diffs;
        }
        self.touch(at);
    }

    /// The agent asks for a permission (`session/request_permission`); returns what to tell the
    /// user it is about.
    pub fn ask(&mut self, request: u64, params: &Value) -> String {
        let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let title = text_of(&call, "title").unwrap_or_default();
        let command = call.get("rawInput").and_then(|i| text_of(i, "command"));
        let mut paths: Vec<String> = locations(&call).unwrap_or_default();
        if paths.is_empty() {
            paths.extend(call.get("rawInput").and_then(|i| text_of(i, "filePath").or_else(|| text_of(i, "path"))));
        }
        let paths = self.shown(&paths);
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|o| Some(AskOption { id: text_of(o, "optionId")?, name: text_of(o, "name").unwrap_or_default(), kind: text_of(o, "kind").unwrap_or_default() }))
            .collect();
        let detail = command.clone().or_else(|| paths.first().cloned()).unwrap_or_else(|| title.clone());
        self.push(Body::Ask { request, title, tool: text_of(&call, "kind").unwrap_or_else(|| "other".into()), command, paths, options, answer: None }, None);
        detail
    }

    /// Record the answer to a waiting request; false when it isn't waiting (answered already).
    pub fn answer(&mut self, request: u64, choice: &str) -> bool {
        let Some(at) = self.entries.iter().position(|e| matches!(&e.item.body, Body::Ask { request: r, answer: None, .. } if *r == request)) else { return false };
        if let Body::Ask { answer, .. } = &mut self.entries[at].item.body {
            *answer = Some(choice.to_string());
        }
        self.touch(at);
        true
    }

    /// Whether `option` is one the agent offered for this waiting request.
    pub fn offers(&self, request: u64, option: &str) -> bool {
        self.entries.iter().any(|e| matches!(&e.item.body, Body::Ask { request: r, answer: None, options, .. } if *r == request && options.iter().any(|o| o.id == option)))
    }

    /// Requests still waiting, oldest first, with what each is about.
    pub fn waiting(&self) -> Vec<(u64, String)> {
        self.entries
            .iter()
            .filter_map(|e| match &e.item.body {
                Body::Ask { request, answer: None, command, paths, title, .. } => Some((*request, command.clone().or_else(|| paths.first().cloned()).unwrap_or_else(|| title.clone()))),
                _ => None,
            })
            .collect()
    }
}

fn choice(c: &Value, group: Option<String>) -> Option<Choice> {
    let value = text_of(c, "value")?;
    Some(Choice { name: text_of(c, "name").unwrap_or_else(|| value.clone()), value, description: text_of(c, "description"), group })
}

fn locations(v: &Value) -> Option<Vec<String>> {
    Some(v.get("locations")?.as_array()?.iter().filter_map(|l| text_of(l, "path")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chat() -> Chat {
        Chat::new(Path::new("/work/shop"))
    }

    fn bodies(c: &Chat) -> Vec<Body> {
        c.since(0).into_iter().map(|i| i.body).collect()
    }

    #[test]
    fn chunks_of_one_message_join_and_a_new_message_starts_a_new_record() {
        let mut c = chat();
        c.user("add divide");
        for (kind, id, text) in [("agent_thought_chunk", "p1", "Let me "), ("agent_thought_chunk", "p1", "look."), ("agent_message_chunk", "m1", "Added "), ("agent_message_chunk", "m1", "`divide`."), ("agent_message_chunk", "m2", "Anything else?")] {
            c.apply(&json!({ "sessionUpdate": kind, "messageId": id, "content": { "type": "text", "text": text } }));
        }
        // Not text: left out.
        c.apply(&json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m2", "content": { "type": "image", "data": "…" } }));
        assert_eq!(
            bodies(&c),
            vec![
                Body::User { text: "add divide".into() },
                Body::Thought { text: "Let me look.".into() },
                Body::Message { text: "Added `divide`.".into() },
                Body::Message { text: "Anything else?".into() },
            ]
        );
    }

    #[test]
    fn a_tool_call_is_one_record_that_its_updates_fill_in() {
        let mut c = chat();
        c.apply(&json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "edit", "kind": "edit", "status": "pending", "locations": [], "rawInput": {} }));
        c.apply(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress", "kind": "edit", "title": "edit", "locations": [{ "path": "/work/shop/src/cart.js" }] }));
        c.apply(&json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "title": "cart.js",
            "content": [{ "type": "content", "content": { "type": "text", "text": "Edit applied successfully." } }, { "type": "diff", "path": "/work/shop/src/cart.js", "oldText": "a\nb\nc\n", "newText": "a\nB\nc\nd\n" }]
        }));
        // A command's working directory isn't a file it touched.
        c.apply(&json!({ "sessionUpdate": "tool_call", "toolCallId": "t2", "title": "bash", "kind": "execute", "status": "pending", "locations": [{ "path": "/work/shop" }] }));
        c.apply(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "completed", "title": "git status", "rawInput": { "command": "git status" }, "rawOutput": { "output": " M src/cart.js\n" } }));
        assert_eq!(
            bodies(&c),
            vec![
                Body::Tool {
                    tool: "edit".into(),
                    title: "cart.js".into(),
                    status: "completed".into(),
                    paths: vec!["src/cart.js".into()],
                    command: None,
                    output: Some("Edit applied successfully.".into()),
                    diffs: vec![DiffStat { path: "src/cart.js".into(), added: 2, removed: 1 }],
                },
                Body::Tool { tool: "execute".into(), title: "git status".into(), status: "completed".into(), paths: vec![], command: Some("git status".into()), output: Some(" M src/cart.js\n".into()), diffs: vec![] },
            ]
        );
    }

    #[test]
    fn only_what_changed_since_a_revision_is_sent_again() {
        let mut c = chat();
        c.user("go");
        c.apply(&json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "read", "kind": "read", "status": "pending" }));
        c.apply(&json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m", "content": { "type": "text", "text": "Done" } }));
        let seen = c.rev();
        assert!(c.since(seen).is_empty());
        c.apply(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" }));
        c.apply(&json!({ "sessionUpdate": "agent_message_chunk", "messageId": "m", "content": { "type": "text", "text": "." } }));
        let changed = c.since(seen);
        assert_eq!(changed.iter().map(|i| i.id).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(changed[1].body, Body::Message { text: "Done.".into() });
    }

    #[test]
    fn a_permission_waits_until_it_is_answered_once() {
        let mut c = chat();
        let detail = c.ask(
            7,
            &json!({
                "toolCall": { "toolCallId": "t1", "title": "rm -rf build", "kind": "execute", "rawInput": { "command": "rm -rf build" }, "locations": [] },
                "options": [{ "optionId": "once", "kind": "allow_once", "name": "Allow once" }, { "optionId": "reject", "kind": "reject_once", "name": "Reject" }]
            }),
        );
        assert_eq!(detail, "rm -rf build");
        assert_eq!(c.waiting(), vec![(7, "rm -rf build".to_string())]);
        assert!(c.offers(7, "once") && !c.offers(7, "always") && !c.offers(8, "once"));
        assert!(c.answer(7, "once"));
        assert!(!c.answer(7, "reject"), "answered already");
        assert!(c.waiting().is_empty());
        // An edit names its file instead of a command.
        let detail = c.ask(8, &json!({ "toolCall": { "title": "edit", "kind": "edit", "rawInput": { "filePath": "/work/shop/a.js" } }, "options": [] }));
        assert_eq!(detail, "a.js");
    }

    #[test]
    fn ending_a_turn_closes_the_tool_calls_it_left_open() {
        let mut c = chat();
        c.apply(&json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "bash", "kind": "execute", "status": "in_progress" }));
        c.end("cancelled");
        let b = bodies(&c);
        assert!(matches!(&b[0], Body::Tool { status, .. } if status == "cancelled"));
        assert_eq!(b[1], Body::End { reason: "cancelled".into() });
    }

    #[test]
    fn the_plan_of_a_turn_is_replaced_not_repeated() {
        let mut c = chat();
        c.user("one");
        c.apply(&json!({ "sessionUpdate": "plan", "entries": [{ "content": "read", "status": "pending" }] }));
        c.apply(&json!({ "sessionUpdate": "plan", "entries": [{ "content": "read", "status": "completed" }, { "content": "edit", "status": "in_progress" }] }));
        c.user("two");
        c.apply(&json!({ "sessionUpdate": "plan", "entries": [{ "content": "test", "status": "pending" }] }));
        let plans: Vec<usize> = bodies(&c).iter().filter_map(|b| if let Body::Plan { entries } = b { Some(entries.len()) } else { None }).collect();
        assert_eq!(plans, vec![2, 1]);
    }

    #[test]
    fn setup_output_stops_being_collected_once_the_agent_is_there() {
        let mut c = chat();
        c.setup_started("pnpm install");
        assert!(c.setup_output("installing\n"));
        c.setup_finished(0);
        assert!(!c.setup_output("agent log line\n"));
        assert_eq!(bodies(&c), vec![Body::Setup { command: "pnpm install".into(), output: "installing\n".into(), code: Some(0) }]);
    }

    #[test]
    fn options_are_the_agents_select_lists_flat_or_grouped() {
        let mut c = chat();
        c.set_options(&json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "a/x", "options": [{ "value": "a/x", "name": "A/X" }, { "value": "b/y", "name": "B/Y", "description": "fast" }] },
            { "id": "effort", "name": "Effort", "type": "select", "currentValue": "low", "options": [{ "group": "g", "name": "Levels", "options": [{ "value": "low", "name": "Low" }] }] },
            { "id": "flag", "type": "boolean", "currentValue": true }
        ]));
        let o = c.options();
        assert_eq!(o.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), vec!["model", "effort"]);
        assert_eq!(o[0].choices[1], Choice { value: "b/y".into(), name: "B/Y".into(), description: Some("fast".into()), group: None });
        assert_eq!(o[1].choices[0].group.as_deref(), Some("Levels"));
        let rev = c.rev();
        c.apply(&json!({ "sessionUpdate": "usage_update", "used": 21661, "size": 200000 }));
        assert_eq!(c.usage(), Some(Usage { used: 21661, size: 200000 }));
        assert!(c.rev() > rev);
    }

    #[test]
    fn line_counts_come_from_the_texts_themselves() {
        assert_eq!(line_stats("", "a\nb\n"), (2, 0));
        assert_eq!(line_stats("a\nb\n", ""), (0, 2));
        assert_eq!(line_stats("a\nb\nc\n", "a\nc\n"), (0, 1));
        // A moved line is one removal and one addition, not a rewrite of everything between.
        assert_eq!(line_stats("a\nb\nc\nd\n", "b\nc\nd\na\n"), (1, 1));
        assert_eq!(line_stats("same\n", "same\n"), (0, 0));
        assert_eq!(line_stats("x\ny\nz", "x\nY\nz"), (1, 1));
    }

    #[test]
    fn a_record_goes_out_as_one_flat_object() {
        let mut c = chat();
        c.user("hi");
        assert_eq!(serde_json::to_value(c.since(0)).unwrap(), json!([{ "id": 1, "rev": 1, "kind": "user", "text": "hi" }]));
    }
}
