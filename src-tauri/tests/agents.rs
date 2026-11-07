//! Agent sessions end to end: a new worktree in a throwaway repository, and real processes in a
//! pseudo-terminal (a stand-in shell script plays the agent).

use retrace_lib::core::agent::{self, Meta, Sessions};
use retrace_lib::core::api::dispatch;
use retrace_lib::core::shell_env::Env;
use retrace_lib::core::State;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(name: &str) -> TempDir {
    let base = std::env::temp_dir().join(format!("retrace-agent-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    TempDir(std::fs::canonicalize(&base).unwrap())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo(base: &Path) -> PathBuf {
    let main = base.join("shop");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    std::fs::write(main.join("README.md"), "hi\n").unwrap();
    git(&main, &["add", "-A"]);
    git(&main, &["commit", "-q", "-m", "init"]);
    main
}

fn env_with(bin: &Path) -> Env {
    let mut env: Env = Env::new();
    env.insert("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()));
    env.insert("TERM".into(), "xterm-256color".into());
    env
}

/// A stand-in agent: prints its arguments and where it runs, then waits for a line.
fn fake_agent(dir: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let path = bin.join(name);
    std::fs::write(&path, "#!/bin/sh\nprintf 'agent args:[%s]\\n' \"$*\"\nprintf 'in:%s main:%s\\n' \"$PWD\" \"$RETRACE_MAIN_TREE\"\nprintf 'ready\\a'\nread line\necho \"got:$line\"\nexit 3\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

fn meta(tree: &Path) -> Meta {
    Meta { project: "p".into(), tree: tree.to_string_lossy().into_owned(), branch: None, agent: "opencode".into(), task: "t".into() }
}

fn output(s: &Sessions, id: &str) -> String {
    String::from_utf8_lossy(&s.read(id, 0).unwrap().0).into_owned()
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let started = Instant::now();
    while !ok() {
        assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn new_worktree_sits_next_to_the_repository_on_a_new_branch() {
    let tmp = temp("tree");
    let main = repo(&tmp.0);
    let tip = git(&main, &["rev-parse", "HEAD"]);
    let path = agent::create_worktree(&main, "agent/fix-login", &tip).unwrap();
    assert_eq!(PathBuf::from(&path), tmp.0.join("shop.worktrees").join("fix-login"));
    assert_eq!(git(Path::new(&path), &["rev-parse", "HEAD"]), tip);
    assert_eq!(git(Path::new(&path), &["branch", "--show-current"]), "agent/fix-login");
    assert!(git(&main, &["worktree", "list", "--porcelain"]).contains(&path));
    // The main tree stays clean: the worktree lives outside it.
    assert_eq!(git(&main, &["status", "--porcelain"]), "");

    // Same branch again, a taken folder, a bad name: refused, nothing created.
    assert!(agent::create_worktree(&main, "agent/fix-login", &tip).unwrap_err().to_string().contains("agent/fix-login"));
    assert!(agent::create_worktree(&main, "other/fix-login", &tip).is_err());
    assert!(agent::create_worktree(&main, "bad..name", &tip).is_err());
    assert!(agent::create_worktree(&main, "-x", &tip).is_err());
    assert_eq!(git(&main, &["branch", "--list", "other/*"]), "");
}

#[test]
fn a_session_relays_output_input_bell_and_exit_code() {
    let tmp = temp("pty");
    let bin = fake_agent(&tmp.0, "opencode");
    let sessions = Arc::new(Sessions::default());
    let kind = agent::kind("opencode").unwrap();
    let launch = agent::launch(kind, "fix it; $(echo nope)", None, &tmp.0, Path::new("/main/tree"), &env_with(&bin), (100, 30)).unwrap();
    let info = sessions.spawn(launch, meta(&tmp.0)).unwrap();
    assert!(info.running);

    wait_for("ready", || output(&sessions, &info.id).contains("ready"));
    let text = output(&sessions, &info.id);
    // The task arrived as one argument, unexpanded.
    assert!(text.contains("agent args:[--prompt fix it; $(echo nope)]"), "{text}");
    assert!(text.contains(&format!("in:{} main:/main/tree", tmp.0.display())), "{text}");
    wait_for("bell", || sessions.list()[0].bell_at.is_some());

    // The terminal answering a query isn't the user answering the agent.
    sessions.write(&info.id, b"", false).unwrap();
    assert!(sessions.list()[0].input_at.is_none());
    sessions.write(&info.id, b"hello\r", true).unwrap();
    assert!(sessions.list()[0].input_at.is_some());
    wait_for("echo", || output(&sessions, &info.id).contains("got:hello"));
    wait_for("exit", || !sessions.list()[0].running);
    assert_eq!(sessions.list()[0].exit_code, Some(3));

    // Reading from the end returns nothing new; closing forgets the session.
    let (_, _, next) = sessions.read(&info.id, 0).unwrap();
    assert!(sessions.read(&info.id, next).unwrap().0.is_empty());
    sessions.close(&info.id).unwrap();
    assert!(sessions.list().is_empty());
    assert!(sessions.write(&info.id, b"x", true).is_err());
}

#[test]
fn setup_runs_first_and_a_failing_setup_keeps_the_agent_from_starting() {
    let tmp = temp("setup");
    let bin = fake_agent(&tmp.0, "codex");
    let sessions = Arc::new(Sessions::default());
    let kind = agent::kind("codex").unwrap();
    let env = env_with(&bin);

    let ok = agent::launch(kind, "go", Some("echo preparing in \"$RETRACE_WORKTREE\""), &tmp.0, &tmp.0, &env, (80, 24)).unwrap();
    let ok = sessions.spawn(ok, meta(&tmp.0)).unwrap();
    wait_for("agent after setup", || output(&sessions, &ok.id).contains("ready"));
    let text = output(&sessions, &ok.id);
    assert!(text.find("preparing in").unwrap() < text.find("agent args:[go]").unwrap(), "{text}");

    let bad = agent::launch(kind, "go", Some("echo preparing\nfalse\necho never"), &tmp.0, &tmp.0, &env, (80, 24)).unwrap();
    let bad = sessions.spawn(bad, meta(&tmp.0)).unwrap();
    wait_for("setup failure", || sessions.list().iter().any(|s| s.id == bad.id && !s.running));
    let text = output(&sessions, &bad.id);
    assert!(text.contains("preparing") && !text.contains("never") && !text.contains("agent args"), "{text}");
    assert_eq!(sessions.list().iter().find(|s| s.id == bad.id).unwrap().exit_code, Some(1));

    assert!(!sessions.list().iter().find(|s| s.id == bad.id).unwrap().stopped);
    sessions.stop(&ok.id).unwrap();
    wait_for("stop", || sessions.list().iter().any(|s| s.id == ok.id && !s.running));
    assert!(sessions.list().iter().find(|s| s.id == ok.id).unwrap().stopped);
}

#[test]
fn an_agent_that_is_not_installed_is_reported_by_name() {
    let tmp = temp("missing");
    let env = env_with(&tmp.0.join("empty"));
    let err = agent::launch(agent::kind("claude").unwrap(), "", None, &tmp.0, &tmp.0, &env, (80, 24)).err().unwrap();
    assert!(err.to_string().contains("claude"), "{err}");
    assert!(agent::kinds(&env).iter().all(|k| k.path.is_none()));
}

#[test]
fn the_dev_bridge_refuses_agent_commands_unless_enabled() {
    let tmp = temp("gate");
    let state = State::with_config(tmp.0.join("config.json"));
    state.agents_allowed.store(false, std::sync::atomic::Ordering::Relaxed);
    let err = dispatch(&state, "agentSessions", json!({})).unwrap_err().to_string();
    assert!(err.contains("RETRACE_DEVBRIDGE_AGENTS"), "{err}");
    assert!(dispatch(&state, "agentStart", json!({ "id": "x", "agent": "opencode" })).is_err());
    state.agents_allowed.store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(dispatch(&state, "agentSessions", json!({})).unwrap(), json!([]));
}

#[test]
fn stopping_also_ends_children_that_ignore_the_hangup() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = temp("group");
    let bin = tmp.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // The agent starts a helper that ignores SIGHUP, reports its pid, and waits.
    let path = bin.join("claude");
    std::fs::write(&path, "#!/bin/sh\n(trap '' HUP; exec sleep 60) &\necho \"child:$!\"\nwait\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sessions = Arc::new(Sessions::default());
    let launch = agent::launch(agent::kind("claude").unwrap(), "", None, &tmp.0, &tmp.0, &env_with(&bin), (80, 24)).unwrap();
    let info = sessions.spawn(launch, meta(&tmp.0)).unwrap();
    wait_for("child pid", || output(&sessions, &info.id).contains("child:"));
    let text = output(&sessions, &info.id);
    let pid: i32 = text.split("child:").nth(1).unwrap().trim().split_whitespace().next().unwrap().parse().unwrap();
    let alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 };
    assert!(alive(pid));
    sessions.stop(&info.id).unwrap();
    wait_for("agent ends", || !sessions.list()[0].running);
    // The helper outlives the hangup, then goes with the group kill.
    let started = Instant::now();
    while alive(pid) && started.elapsed() < Duration::from_secs(8) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!alive(pid), "helper {pid} survived the stop");
}
