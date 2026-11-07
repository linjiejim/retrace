//! Agent sessions: a coding agent's own terminal UI running in a pseudo-terminal, kept alive in
//! the background while Retrace is open. Retrace only relays bytes; the agent does the work.
//!
//! What Retrace writes here: a new worktree and branch for a session (when asked), nothing else.

use super::git;
use super::repo;
use super::shell_env::{self, Env};
use crate::tr;
use anyhow::{anyhow, bail, Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

// ---------- the agents we know ----------

pub struct Kind {
    pub id: &'static str,
    pub name: &'static str,
    binary: &'static str,
}

/// Built-in agents. Each is just how to start its terminal UI with a task.
pub const KINDS: &[Kind] = &[
    Kind { id: "opencode", name: "OpenCode", binary: "opencode" },
    Kind { id: "codex", name: "Codex", binary: "codex" },
    Kind { id: "claude", name: "Claude Code", binary: "claude" },
];

impl Kind {
    pub fn binary_name(&self) -> &'static str {
        self.binary
    }

    /// Arguments that start the UI with `task` already submitted (none for an empty task).
    pub fn args(&self, task: &str) -> Vec<String> {
        let task = task.trim();
        if task.is_empty() {
            return vec![];
        }
        match self.id {
            "opencode" => vec!["--prompt".into(), task.into()],
            _ => vec![task.into()],
        }
    }
}

pub fn kind(id: &str) -> Result<&'static Kind> {
    KINDS.iter().find(|k| k.id == id).ok_or_else(|| anyhow!(tr!("不认识的 agent：{id}", "Unknown agent: {id}")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindInfo {
    pub id: String,
    pub name: String,
    /// Where it is installed; none when it isn't on the login shell's PATH.
    pub path: Option<String>,
}

pub fn kinds(env: &Env) -> Vec<KindInfo> {
    KINDS
        .iter()
        .map(|k| KindInfo { id: k.id.into(), name: k.name.into(), path: shell_env::which(env, k.binary).map(|p| p.to_string_lossy().into_owned()) })
        .collect()
}

// ---------- what to run ----------

pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Env,
    pub cols: u16,
    pub rows: u16,
}

/// The agent in `tree`, with the task as its own argument (never spliced into a shell string).
/// A setup command runs first in `/bin/sh -e`; the agent starts only if it succeeds.
pub fn launch(kind: &Kind, task: &str, setup: Option<&str>, tree: &Path, main_tree: &Path, env: &Env, size: (u16, u16)) -> Result<Launch> {
    let bin = shell_env::which(env, kind.binary)
        .ok_or_else(|| anyhow!(tr!("找不到 {}：登录 shell 的 PATH 里没有 `{}`", "Can't find {}: `{}` isn't on your login shell's PATH", kind.name, kind.binary)))?;
    let mut env = env.clone();
    env.insert("RETRACE_MAIN_TREE".into(), main_tree.to_string_lossy().into_owned());
    env.insert("RETRACE_WORKTREE".into(), tree.to_string_lossy().into_owned());
    let agent_args = kind.args(task);
    let (program, args) = match setup.map(str::trim).filter(|s| !s.is_empty()) {
        Some(setup) => {
            let mut args = vec!["-e".to_string(), "-c".to_string(), format!("{setup}\nexec \"$0\" \"$@\"")];
            args.push(bin.to_string_lossy().into_owned());
            args.extend(agent_args);
            (PathBuf::from("/bin/sh"), args)
        }
        None => (bin, agent_args),
    };
    Ok(Launch { program, args, cwd: tree.to_path_buf(), env, cols: size.0.clamp(20, 500), rows: size.1.clamp(5, 300) })
}

// ---------- new worktree ----------

/// `<parent>/<repo>.worktrees/<last part of the branch>`, next to the repository.
pub fn tree_path(root: &Path, branch: &str) -> Result<PathBuf> {
    let parent = root.parent().ok_or_else(|| anyhow!(tr!("项目目录没有上级目录", "The project folder has no parent folder")))?;
    let leaf = branch.rsplit('/').next().unwrap_or(branch);
    if leaf.is_empty() || leaf == "." || leaf == ".." {
        bail!(tr!("分支名不能用作目录名：{branch}", "This branch name can't be a folder name: {branch}"));
    }
    Ok(parent.join(format!("{}.worktrees", repo::display_name(root))).join(leaf))
}

/// A new branch at `base` checked out in a new worktree next to the repository. Refuses when
/// the branch or the folder already exists: the name is the user's to change.
pub fn create_worktree(root: &Path, branch: &str, base: &str) -> Result<String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.chars().any(char::is_control) {
        bail!(tr!("分支名无效：{branch}", "Invalid branch name: {branch}"));
    }
    if git::code(root, &["check-ref-format", "--branch", branch])?.0 != 0 {
        bail!(tr!("分支名无效：{branch}", "Invalid branch name: {branch}"));
    }
    if git::code(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])?.0 == 0 {
        bail!(tr!("分支 {branch} 已经存在，换个名字", "Branch {branch} already exists; pick another name"));
    }
    if base.starts_with('-') {
        bail!(tr!("提交标识无效", "Invalid commit id"));
    }
    let path = tree_path(root, branch)?;
    if path.exists() {
        bail!(tr!("{} 已经存在，换个分支名", "{} already exists; pick another branch name", path.display()));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| tr!("无法创建 {}", "Can't create {}", dir.display()))?;
    }
    let path_text = path.to_string_lossy().into_owned();
    git::run(root, &["worktree", "add", "-b", branch, &path_text, base])?;
    // The path as git lists it (symlinks resolved the same way), so the UI can match its tab.
    let real = std::fs::canonicalize(&path).unwrap_or(path);
    let listed = repo::worktrees(root)?
        .into_iter()
        .find(|t| std::fs::canonicalize(&t.path).is_ok_and(|p| p == real))
        .map(|t| t.path)
        .unwrap_or_else(|| real.to_string_lossy().into_owned());
    Ok(listed)
}

// ---------- terminal output scanning ----------

/// What the byte stream said besides drawing: the bell, a window title, a desktop notification.
#[derive(Debug, PartialEq)]
pub enum Signal {
    Bell,
    Title(String),
    Notify,
}

#[derive(Default)]
enum ScanState {
    #[default]
    Text,
    Esc,
    Osc,
    OscEsc,
}

/// Finds BEL outside escape sequences and OSC 0/2 (title), 9 and 777 (notifications); keeps its
/// place across reads, since a sequence can be split between two of them.
#[derive(Default)]
pub struct Scanner {
    state: ScanState,
    osc: Vec<u8>,
}

const OSC_MAX: usize = 1024;

impl Scanner {
    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<Signal>) {
        for &b in bytes {
            self.state = match (std::mem::take(&mut self.state), b) {
                (ScanState::Text, 0x07) => {
                    out.push(Signal::Bell);
                    ScanState::Text
                }
                (ScanState::Text, 0x1b) => ScanState::Esc,
                (ScanState::Text, _) => ScanState::Text,
                (ScanState::Esc, b']') => {
                    self.osc.clear();
                    ScanState::Osc
                }
                (ScanState::Esc, 0x1b) => ScanState::Esc,
                (ScanState::Esc, _) => ScanState::Text,
                (ScanState::Osc, 0x07) => {
                    self.finish(out);
                    ScanState::Text
                }
                (ScanState::Osc, 0x1b) => ScanState::OscEsc,
                (ScanState::Osc, b) => {
                    if self.osc.len() < OSC_MAX {
                        self.osc.push(b);
                    }
                    ScanState::Osc
                }
                (ScanState::OscEsc, b'\\') => {
                    self.finish(out);
                    ScanState::Text
                }
                // ESC inside an OSC that isn't a terminator: the OSC was cut off; start over.
                (ScanState::OscEsc, b']') => {
                    self.osc.clear();
                    ScanState::Osc
                }
                (ScanState::OscEsc, _) => ScanState::Text,
            };
        }
    }

    fn finish(&mut self, out: &mut Vec<Signal>) {
        let payload = String::from_utf8_lossy(&self.osc).into_owned();
        self.osc.clear();
        let (code, rest) = payload.split_once(';').unwrap_or((payload.as_str(), ""));
        match code {
            "0" | "2" => out.push(Signal::Title(rest.chars().filter(|c| !c.is_control()).take(200).collect())),
            // `9;4;…` is a progress report (ConEmu), not a notification.
            "9" if !rest.starts_with("4;") => out.push(Signal::Notify),
            "777" if rest.starts_with("notify") => out.push(Signal::Notify),
            _ => {}
        }
    }
}

// ---------- sessions ----------

/// What the UI lists. Times are milliseconds since the epoch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub project: String,
    pub tree: String,
    pub branch: Option<String>,
    pub agent: String,
    pub task: String,
    /// Set by the agent through the terminal title.
    pub title: Option<String>,
    pub started_at: i64,
    pub last_output_at: i64,
    /// The last bell or desktop notification.
    pub bell_at: Option<i64>,
    /// The last time the user typed or sent something.
    pub input_at: Option<i64>,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Ended because the user stopped or closed it, not on its own.
    pub stopped: bool,
}

pub struct Meta {
    pub project: String,
    pub tree: String,
    pub branch: Option<String>,
    pub agent: String,
    pub task: String,
}

pub enum Event {
    Output { session: String, offset: u64, data: Vec<u8> },
    Changed { session: String },
}

pub type Notify = Arc<dyn Fn(Event) + Send + Sync>;

/// Scrollback kept for a view that attaches late (or reloads).
const BUFFER_MAX: usize = 2 * 1024 * 1024;

struct Buffer {
    data: VecDeque<u8>,
    /// Stream offset of `data[0]`.
    start: u64,
}

impl Buffer {
    fn end(&self) -> u64 {
        self.start + self.data.len() as u64
    }

    fn push(&mut self, bytes: &[u8]) {
        self.data.extend(bytes);
        let excess = self.data.len().saturating_sub(BUFFER_MAX);
        if excess > 0 {
            self.data.drain(..excess);
            self.start += excess as u64;
        }
    }

    /// Bytes from `from` on (or from the oldest kept byte), and where they start.
    fn read(&self, from: u64) -> (Vec<u8>, u64) {
        let from = from.clamp(self.start, self.end());
        let skip = (from - self.start) as usize;
        (self.data.iter().skip(skip).copied().collect(), from)
    }
}

struct Session {
    info: Mutex<SessionInfo>,
    buffer: Mutex<Buffer>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

impl Session {
    fn running(&self) -> bool {
        self.info.lock().map(|i| i.running).unwrap_or(false)
    }

    /// Hang up the whole process group (the agent and whatever it started); kill it if it is
    /// still there a few seconds later.
    fn hang_up(self: &Arc<Self>) {
        if let Ok(mut i) = self.info.lock() {
            i.stopped = true;
        }
        let Some(pid) = self.pid.map(|p| p as i32).filter(|p| *p > 1) else {
            let _ = self.killer.lock().map(|mut k| k.kill());
            return;
        };
        unsafe {
            libc::killpg(pid, libc::SIGHUP);
        }
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if me.running() {
                unsafe {
                    libc::killpg(pid, libc::SIGKILL);
                }
            }
        });
    }
}

#[derive(Default)]
pub struct Sessions {
    list: Mutex<Vec<Arc<Session>>>,
    notify: RwLock<Option<Notify>>,
    next: AtomicU64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Sessions {
    /// Where output and state changes go (the app's event bus); without it, callers poll.
    pub fn set_notify(&self, notify: Notify) {
        if let Ok(mut n) = self.notify.write() {
            *n = Some(notify);
        }
    }

    fn emit(&self, event: Event) {
        let notify = self.notify.read().ok().and_then(|n| n.clone());
        if let Some(n) = notify {
            n(event);
        }
    }

    fn get(&self, id: &str) -> Result<Arc<Session>> {
        let list = self.list.lock().map_err(|_| anyhow!("sessions"))?;
        list.iter()
            .find(|s| s.info.lock().is_ok_and(|i| i.id == id))
            .cloned()
            .ok_or_else(|| anyhow!(tr!("会话已经关闭", "The session has been closed")))
    }

    pub fn spawn(self: &Arc<Self>, launch: Launch, meta: Meta) -> Result<SessionInfo> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: launch.rows, cols: launch.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| anyhow!(tr!("无法打开终端：{e}", "Can't open a terminal: {e}")))?;
        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        cmd.cwd(&launch.cwd);
        cmd.env_clear();
        for (k, v) in &launch.env {
            cmd.env(k, v);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!(tr!("无法启动 {}：{e}", "Can't start {}: {e}", launch.program.display())))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| anyhow!("{e}"))?;
        let writer = pair.master.take_writer().map_err(|e| anyhow!("{e}"))?;
        let now = now_ms();
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        let info = SessionInfo {
            id: format!("s{now:x}{n}"),
            project: meta.project,
            tree: meta.tree,
            branch: meta.branch,
            agent: meta.agent,
            task: meta.task,
            title: None,
            started_at: now,
            last_output_at: now,
            bell_at: None,
            input_at: None,
            running: true,
            exit_code: None,
            stopped: false,
        };
        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            buffer: Mutex::new(Buffer { data: VecDeque::new(), start: 0 }),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
            pid: child.process_id(),
            master: Mutex::new(Some(pair.master)),
        });
        self.list.lock().map_err(|_| anyhow!("sessions"))?.push(session.clone());

        let (me, s) = (self.clone(), session.clone());
        std::thread::spawn(move || me.pump(s, reader));
        let (me, s) = (self.clone(), session);
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) if status.success() => 0,
                Ok(status) => status.exit_code().max(1) as i32,
                Err(_) => -1,
            };
            let id = match s.info.lock() {
                Ok(mut i) => {
                    i.running = false;
                    i.exit_code = Some(code);
                    i.id.clone()
                }
                Err(_) => return,
            };
            me.emit(Event::Changed { session: id });
        });
        self.emit(Event::Changed { session: info.id.clone() });
        Ok(info)
    }

    /// Output → scrollback, signals → state, then out to the UI.
    fn pump(&self, s: Arc<Session>, mut reader: Box<dyn Read + Send>) {
        let mut scanner = Scanner::default();
        let mut buf = vec![0u8; 64 * 1024];
        let mut signals = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];
            let offset = match s.buffer.lock() {
                Ok(mut b) => {
                    let at = b.end();
                    b.push(chunk);
                    at
                }
                Err(_) => break,
            };
            signals.clear();
            scanner.feed(chunk, &mut signals);
            let now = now_ms();
            let (id, changed) = match s.info.lock() {
                Ok(mut i) => {
                    i.last_output_at = now;
                    let mut changed = false;
                    for sig in signals.drain(..) {
                        match sig {
                            Signal::Bell | Signal::Notify => {
                                i.bell_at = Some(now);
                                changed = true;
                            }
                            Signal::Title(t) if i.title.as_deref() != Some(t.as_str()) => {
                                i.title = Some(t).filter(|t| !t.is_empty());
                                changed = true;
                            }
                            Signal::Title(_) => {}
                        }
                    }
                    (i.id.clone(), changed)
                }
                Err(_) => break,
            };
            self.emit(Event::Output { session: id.clone(), offset, data: chunk.to_vec() });
            if changed {
                self.emit(Event::Changed { session: id });
            }
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.list.lock().map(|l| l.iter().filter_map(|s| s.info.lock().ok().map(|i| i.clone())).collect()).unwrap_or_default()
    }

    /// Scrollback from `from`: `(bytes, where they start, where the stream is now)`.
    pub fn read(&self, id: &str, from: u64) -> Result<(Vec<u8>, u64, u64)> {
        let s = self.get(id)?;
        let b = s.buffer.lock().map_err(|_| anyhow!("buffer"))?;
        let (data, start) = b.read(from);
        Ok((data, start, b.end()))
    }

    /// `typed`: the user's input, which answers a bell; terminal replies to queries are not.
    pub fn write(&self, id: &str, bytes: &[u8], typed: bool) -> Result<()> {
        let s = self.get(id)?;
        if !s.running() {
            bail!(tr!("会话已经结束", "The session has ended"));
        }
        {
            let mut w = s.writer.lock().map_err(|_| anyhow!("writer"))?;
            w.write_all(bytes)?;
            w.flush()?;
        }
        if typed {
            if let Ok(mut i) = s.info.lock() {
                i.input_at = Some(now_ms());
            }
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let s = self.get(id)?;
        let master = s.master.lock().map_err(|_| anyhow!("pty"))?;
        if let Some(m) = master.as_ref() {
            m.resize(PtySize { rows: rows.clamp(5, 300), cols: cols.clamp(20, 500), pixel_width: 0, pixel_height: 0 }).map_err(|e| anyhow!("{e}"))?;
        }
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let s = self.get(id)?;
        if s.running() {
            s.hang_up();
        }
        Ok(())
    }

    /// Stop it if needed and forget it: the terminal closes, the worktree stays.
    pub fn close(&self, id: &str) -> Result<()> {
        let s = self.get(id)?;
        if s.running() {
            s.hang_up();
        }
        if let Ok(mut m) = s.master.lock() {
            m.take();
        }
        if let Ok(mut list) = self.list.lock() {
            list.retain(|x| !Arc::ptr_eq(x, &s));
        }
        self.emit(Event::Changed { session: id.to_string() });
        Ok(())
    }

    pub fn running_count(&self) -> usize {
        self.list.lock().map(|l| l.iter().filter(|s| s.running()).count()).unwrap_or(0)
    }

    /// The app is quitting: hang up every agent.
    pub fn stop_all(&self) {
        let list = self.list.lock().map(|l| l.clone()).unwrap_or_default();
        for s in list.iter().filter(|s| s.running()) {
            if let Some(pid) = s.pid.map(|p| p as i32).filter(|p| *p > 1) {
                unsafe {
                    libc::killpg(pid, libc::SIGHUP);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunks: &[&[u8]]) -> Vec<Signal> {
        let mut s = Scanner::default();
        let mut out = Vec::new();
        for c in chunks {
            s.feed(c, &mut out);
        }
        out
    }

    #[test]
    fn bell_outside_sequences_only() {
        assert_eq!(scan(&[b"done\x07"]), vec![Signal::Bell]);
        // BEL that ends an OSC is not a bell.
        assert_eq!(scan(&[b"\x1b]0;OC | Fix login\x07"]), vec![Signal::Title("OC | Fix login".into())]);
        assert_eq!(scan(&[b"\x1b]2;title\x1b\\"]), vec![Signal::Title("title".into())]);
    }

    #[test]
    fn sequences_split_across_reads() {
        assert_eq!(scan(&[b"\x1b", b"]0;ab", b"c\x07", b"\x07"]), vec![Signal::Title("abc".into()), Signal::Bell]);
        assert_eq!(scan(&[b"\x1b]9;Task done", b"\x1b", b"\\"]), vec![Signal::Notify]);
    }

    #[test]
    fn notifications_but_not_progress_or_colour_queries() {
        assert_eq!(scan(&[b"\x1b]777;notify;Codex;done\x07"]), vec![Signal::Notify]);
        assert!(scan(&[b"\x1b]9;4;1;50\x07"]).is_empty());
        assert!(scan(&[b"\x1b]11;?\x07\x1b]10;rgb:ff/ff/ff\x1b\\"]).is_empty());
        assert!(scan(&[b"\x1b[31mred\x1b[0m"]).is_empty());
    }

    #[test]
    fn scrollback_keeps_offsets_when_trimmed() {
        let mut b = Buffer { data: VecDeque::new(), start: 0 };
        b.push(&vec![1u8; BUFFER_MAX]);
        b.push(&[2, 3]);
        assert_eq!(b.start, 2);
        assert_eq!(b.end(), BUFFER_MAX as u64 + 2);
        let (tail, at) = b.read(BUFFER_MAX as u64);
        assert_eq!((tail, at), (vec![2, 3], BUFFER_MAX as u64));
        // Asking for bytes already dropped starts at the oldest one kept.
        assert_eq!(b.read(0).1, 2);
    }

    #[test]
    fn task_is_its_own_argument() {
        let k = kind("opencode").unwrap();
        assert_eq!(k.args("  fix `rm -rf` \"quotes\"; $(x) "), vec!["--prompt".to_string(), "fix `rm -rf` \"quotes\"; $(x)".to_string()]);
        assert!(k.args("  ").is_empty());
        assert_eq!(kind("codex").unwrap().args("go"), vec!["go".to_string()]);
        assert!(kind("vim").is_err());
    }

    #[test]
    fn worktree_goes_next_to_the_repository() {
        let p = tree_path(Path::new("/Users/me/Code/retrace"), "agent/fix-login").unwrap();
        assert_eq!(p, PathBuf::from("/Users/me/Code/retrace.worktrees/fix-login"));
        assert!(tree_path(Path::new("/Users/me/Code/retrace"), "agent/..").is_err());
    }
}
