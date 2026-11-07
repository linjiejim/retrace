//! The environment agents run with. An app started from the Dock gets a bare PATH and none of the
//! API keys set in the user's shell profile, so ask the login shell once and keep its answer.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub type Env = BTreeMap<String, String>;

const MARKER: &str = "__RETRACE_ENV_BEGIN__";
const TIMEOUT: Duration = Duration::from_secs(10);

/// Left by the terminal or agent that started Retrace (in development), never by the user's
/// profile: an agent seeing them would think it runs inside that terminal or agent.
const HOST_VARS: &[&str] = &[
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "COLORFGBG",
    "TMUX",
    "TMUX_PANE",
    "STY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "OPENCODE",
];
const HOST_PREFIXES: &[&str] = &["ITERM_", "KITTY_", "GHOSTTY_", "WEZTERM_", "VSCODE_", "ZELLIJ", "ALACRITTY_", "WT_"];

static RESOLVED: OnceLock<Env> = OnceLock::new();

/// The login shell's environment (cached), cleaned of host-terminal variables, with a
/// 256-colour terminal type.
pub fn agent_env() -> &'static Env {
    RESOLVED.get_or_init(|| {
        let shell = std::env::var("SHELL").ok().filter(|s| Path::new(s).is_absolute()).unwrap_or_else(|| "/bin/zsh".into());
        let env = login_env(&shell).unwrap_or_else(fallback_env);
        clean(env)
    })
}

/// Warm the cache off the main path (the first new-session dialog would otherwise wait for it).
pub fn prefetch() {
    std::thread::spawn(|| {
        let _ = agent_env();
    });
}

fn login_env(shell: &str) -> Option<Env> {
    let script = format!("printf '\\n{MARKER}\\n'; /usr/bin/env -0");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("TERM", "dumb")
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = reader.join().ok()?;
    let env = parse(&out)?;
    env.contains_key("PATH").then_some(env)
}

/// `env -0` output after the marker line; whatever the profile printed before it is skipped.
pub fn parse(out: &[u8]) -> Option<Env> {
    let marker = format!("\n{MARKER}\n");
    let at = out.windows(marker.len()).rposition(|w| w == marker.as_bytes())?;
    let body = &out[at + marker.len()..];
    let mut env = Env::new();
    for entry in body.split(|b| *b == 0) {
        let entry = String::from_utf8_lossy(entry);
        if let Some((k, v)) = entry.split_once('=') {
            if !k.is_empty() && !k.contains('\n') {
                env.insert(k.to_string(), v.to_string());
            }
        }
    }
    (!env.is_empty()).then_some(env)
}

fn fallback_env() -> Env {
    let mut env: Env = std::env::vars().collect();
    let path = env.get("PATH").cloned().unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    env.insert("PATH".into(), format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    env
}

pub fn clean(mut env: Env) -> Env {
    env.retain(|k, _| !HOST_VARS.contains(&k.as_str()) && !HOST_PREFIXES.iter().any(|p| k.starts_with(p)));
    // Interactive-shell leftovers that mean nothing to a new process.
    for k in ["SHLVL", "OLDPWD", "PWD", "_", "PS1", "PROMPT", "RPROMPT"] {
        env.remove(k);
    }
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.entry("LANG".into()).or_insert_with(|| "en_US.UTF-8".into());
    env
}

/// `name` on `env`'s PATH, as an absolute path to an executable file.
pub fn which(env: &Env, name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = env.get("PATH")?;
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_after_the_marker_and_ignores_profile_noise() {
        let mut out = b"Welcome!\n\x1b[31mprompt noise\x1b[0m\n".to_vec();
        out.extend_from_slice(format!("\n{MARKER}\n").as_bytes());
        out.extend_from_slice(b"PATH=/a:/b\0OPENAI_API_KEY=sk-test\0MULTI=line1\nline2\0");
        let env = parse(&out).unwrap();
        assert_eq!(env["PATH"], "/a:/b");
        assert_eq!(env["OPENAI_API_KEY"], "sk-test");
        assert_eq!(env["MULTI"], "line1\nline2");
        assert!(parse(b"no marker here").is_none());
    }

    #[test]
    fn cleaning_drops_host_terminal_variables() {
        let env: Env = [
            ("PATH", "/bin"),
            ("TERM_PROGRAM", "ghostty"),
            ("GHOSTTY_RESOURCES_DIR", "/x"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("CODEX_HOME", "/c"),
            ("TERM", "dumb"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let env = clean(env);
        assert!(!env.contains_key("TERM_PROGRAM") && !env.contains_key("GHOSTTY_RESOURCES_DIR") && !env.contains_key("CLAUDECODE"));
        // The user's own agent settings stay.
        assert_eq!(env["CLAUDE_CODE_USE_BEDROCK"], "1");
        assert_eq!(env["CODEX_HOME"], "/c");
        assert_eq!(env["TERM"], "xterm-256color");
    }

    #[test]
    fn which_finds_executables_only() {
        let env: Env = [("PATH".to_string(), "/nonexistent:/bin".to_string())].into_iter().collect();
        assert_eq!(which(&env, "sh"), Some(PathBuf::from("/bin/sh")));
        assert_eq!(which(&env, "definitely-not-a-command"), None);
    }
}
