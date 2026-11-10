//! Runs the system `git`. Every call is read-only friendly: optional locks are
//! off (agents may be committing in the same tree), prompts are off, and the
//! output is plain and unquoted.

use crate::tr;
use anyhow::{bail, Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static GIT: OnceLock<PathBuf> = OnceLock::new();

/// Apps started from Finder get a minimal PATH, so look in the usual places first.
pub fn binary() -> &'static Path {
    GIT.get_or_init(|| {
        for candidate in ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"] {
            if Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
        PathBuf::from("git")
    })
}

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(binary());
    c.args(["-c", "color.ui=false", "-c", "core.quotepath=false", "-c", "log.showSignature=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null());
    c
}

/// A counting gate: at most `max` holders at once; the rest wait their turn.
struct Gate {
    max: usize,
    busy: std::sync::Mutex<usize>,
    cv: std::sync::Condvar,
}

impl Gate {
    const fn new(max: usize) -> Self {
        Self { max, busy: std::sync::Mutex::new(0), cv: std::sync::Condvar::new() }
    }

    fn enter(&'static self) -> Pass {
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        while *busy >= self.max {
            busy = self.cv.wait(busy).unwrap_or_else(|e| e.into_inner());
        }
        *busy += 1;
        Pass(self)
    }
}

struct Pass(&'static Gate);

impl Drop for Pass {
    fn drop(&mut self) {
        let mut busy = self.0.busy.lock().unwrap_or_else(|e| e.into_inner());
        *busy -= 1;
        self.0.cv.notify_one();
    }
}

/// Every git child process goes through here. A burst of requests (a commit with hundreds of
/// images read at once) would otherwise start hundreds of processes and run the app out of file
/// descriptors (a Finder-launched app gets 256), failing reads at random.
static PROCESSES: Gate = Gate::new(16);

fn launch(dir: &Path, args: &[&str]) -> Result<Output> {
    let _pass = PROCESSES.enter();
    command(dir, args)
        .output()
        .with_context(|| tr!("无法运行 git（{}）", "Can't run git ({})", binary().display()))
}

fn failure(args: &[&str], out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let reason = stderr.trim().lines().last().unwrap_or("").trim_start_matches("fatal: ");
    tr!("git {} 失败：{}", "git {} failed: {}", args.first().copied().unwrap_or(""), reason)
}

/// Stdout of a successful call; a non-zero exit becomes an error with git's own message.
pub fn run(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = launch(dir, args)?;
    if !out.status.success() {
        bail!(failure(args, &out));
    }
    Ok(out.stdout)
}

pub fn text(dir: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&run(dir, args)?).into_owned())
}

/// For commands whose exit code is an answer (`merge-base --is-ancestor`, `merge-tree`).
pub fn code(dir: &Path, args: &[&str]) -> Result<(i32, Vec<u8>)> {
    let out = launch(dir, args)?;
    Ok((out.status.code().unwrap_or(-1), out.stdout))
}

/// At most this many `git status`-class scans run at once across the whole app: with many
/// projects and worktrees they are the expensive part and would otherwise all start together.
static HEAVY: Gate = Gate::new(4);

/// `run` for working-tree scans (`status`), queued behind `HEAVY_SLOTS`.
pub fn run_heavy(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    // Always heavy first, then a process slot (in `run`): one order, so no deadlock.
    let _slot = HEAVY.enter();
    run(dir, args)
}

/// Like `code`, with extra environment variables (e.g. a scratch object directory).
pub fn code_with_env(dir: &Path, args: &[&str], env: &[(&str, &std::ffi::OsStr)]) -> Result<(i32, Vec<u8>)> {
    let _pass = PROCESSES.enter();
    let mut c = command(dir, args);
    for (k, v) in env {
        c.env(k, v);
    }
    let out = c.output().with_context(|| tr!("无法运行 git（{}）", "Can't run git ({})", binary().display()))?;
    Ok((out.status.code().unwrap_or(-1), out.stdout))
}

/// A temporary directory removed on drop.
pub struct ScratchDir(PathBuf);

impl ScratchDir {
    pub fn new(tag: &str) -> Option<Self> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("retrace-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        Some(Self(dir))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Stdout up to `max` bytes; past that the process is stopped and `true` says the output was cut.
pub fn run_limited(dir: &Path, args: &[&str], max: usize) -> Result<(Vec<u8>, bool)> {
    run_limited_with_input(dir, args, None, max)
}

/// `run_limited` with `input` on stdin, written from its own thread so a process that answers
/// while it reads can't fill its output pipe and stall us both.
pub fn run_limited_with_input(dir: &Path, args: &[&str], input: Option<Vec<u8>>, max: usize) -> Result<(Vec<u8>, bool)> {
    use std::io::Write;
    let _pass = PROCESSES.enter();
    let mut child = command(dir, args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| tr!("无法运行 git（{}）", "Can't run git ({})", binary().display()))?;
    let writer = input.zip(child.stdin.take()).map(|(input, mut stdin)| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let mut stdout = child.stdout.take().expect("piped stdout");
    // Drain stderr on its own thread: a process that fills the stderr pipe would otherwise block
    // while we wait on stdout. Keep only the tail for the error message.
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let stderr_reader = std::thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr_pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 16 * 1024 {
                tail.drain(..tail.len() - 16 * 1024);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    let mut cut = false;
    loop {
        let n = stdout.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if out.len() > max {
            cut = true;
            let _ = child.kill();
            break;
        }
    }
    let status = child.wait()?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if let Some(w) = writer {
        let _ = w.join();
    }
    if !cut && !status.success() {
        let reason = stderr.trim().lines().last().unwrap_or("").trim_start_matches("fatal: ").to_string();
        bail!(tr!("git {} 失败：{}", "git {} failed: {}", args.first().copied().unwrap_or(""), reason));
    }
    Ok((out, cut))
}

/// `run` with `input` on stdin (`patch-id`). The input is written from its own thread, so a
/// process that answers while it reads can't fill its output pipe and stall us both.
pub fn run_with_input(dir: &Path, args: &[&str], input: Vec<u8>) -> Result<Vec<u8>> {
    use std::io::Write;
    let _pass = PROCESSES.enter();
    let mut child = command(dir, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| tr!("无法运行 git（{}）", "Can't run git ({})", binary().display()))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output()?;
    let _ = writer.join();
    if !out.status.success() {
        bail!(failure(args, &out));
    }
    Ok(out.stdout)
}

/// A network call that ran to the end, successfully or not.
pub struct Finished {
    pub ok: bool,
    /// The exit code; `None` when a signal ended it.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Waits for a spawned child with piped stdout and stderr, draining both while it runs so a full
/// pipe can't stall it. `None`: it ran past `timeout` and was stopped.
pub fn wait_for(mut child: std::process::Child, timeout: Duration) -> std::io::Result<Option<Finished>> {
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(Finished { ok: status.success(), code: status.code(), stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() }));
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Long-running network calls (fetch, push) get a hard timeout so a stuck remote can't pile up
/// processes. Only running out of time or failing to start is an error; a git failure is `ok: false`.
pub fn run_with_timeout_output(dir: &Path, args: &[&str], timeout: Duration) -> Result<Finished> {
    let _pass = PROCESSES.enter();
    let child = command(dir, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| tr!("无法运行 git（{}）", "Can't run git ({})", binary().display()))?;
    match wait_for(child, timeout)? {
        Some(done) => Ok(done),
        None => bail!(tr!("git {} 超时（{} 秒）", "git {} timed out ({} s)", args.first().copied().unwrap_or(""), timeout.as_secs())),
    }
}

/// The last line git wrote to stderr, without its `fatal:` / `error:` prefix.
pub fn last_error_line(stderr: &str) -> &str {
    let line = stderr.trim().lines().last().unwrap_or("").trim();
    line.strip_prefix("fatal: ").or_else(|| line.strip_prefix("error: ")).unwrap_or(line)
}

pub fn run_with_timeout(dir: &Path, args: &[&str], timeout: Duration) -> Result<()> {
    let out = run_with_timeout_output(dir, args, timeout)?;
    if !out.ok {
        bail!(tr!("git {} 失败：{}", "git {} failed: {}", args.first().copied().unwrap_or(""), last_error_line(&out.stderr)));
    }
    Ok(())
}

/// Splits NUL-terminated output into tokens, dropping the trailing empty one.
pub fn nul_tokens(bytes: &[u8]) -> Vec<String> {
    let mut parts: Vec<String> = bytes.split(|b| *b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    if parts.last().is_some_and(|s| s.is_empty()) {
        parts.pop();
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::Gate;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn gate_never_lets_more_than_max_through() {
        static GATE: Gate = Gate::new(3);
        static INSIDE: AtomicUsize = AtomicUsize::new(0);
        static PEAK: AtomicUsize = AtomicUsize::new(0);
        let threads: Vec<_> = (0..24)
            .map(|_| {
                std::thread::spawn(|| {
                    let _pass = GATE.enter();
                    let now = INSIDE.fetch_add(1, Ordering::SeqCst) + 1;
                    PEAK.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    INSIDE.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(PEAK.load(Ordering::SeqCst), 3);
    }
}
