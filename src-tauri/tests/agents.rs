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
    assert!(text.find("preparing in").unwrap() < text.find("agent args:[--no-daemon -- go]").unwrap(), "{text}");

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

#[test]
fn quitting_waits_for_agents_and_helpers_that_ignore_the_hangup() {
    check_quitting_ignoring_hangup(false);
}

#[test]
fn quitting_also_waits_for_a_session_whose_terminal_was_just_closed() {
    check_quitting_ignoring_hangup(true);
}

fn check_quitting_ignoring_hangup(close_first: bool) {
    use std::os::unix::fs::PermissionsExt;
    let tmp = temp(if close_first { "quit-closed-group" } else { "quit-group" });
    let bin = tmp.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let path = bin.join("claude");
    // Both the agent and the helper need SIGKILL, not just a hangup, before quitting.
    std::fs::write(&path, "#!/bin/sh\ntrap '' HUP\nsleep 60 &\necho \"child:$!\"\nwait\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sessions = Arc::new(Sessions::default());
    let launch = agent::launch(agent::kind("claude").unwrap(), "", None, &tmp.0, &tmp.0, &env_with(&bin), (80, 24)).unwrap();
    let info = sessions.spawn(launch, meta(&tmp.0)).unwrap();
    wait_for("child pid", || output(&sessions, &info.id).contains("child:"));
    let text = output(&sessions, &info.id);
    let pid: i32 = text.split("child:").nth(1).unwrap().trim().split_whitespace().next().unwrap().parse().unwrap();
    if close_first {
        sessions.close(&info.id).unwrap();
        assert!(sessions.list().is_empty());
        assert!(sessions.tree_in_use(&tmp.0.to_string_lossy()));
        assert!(sessions.with_idle_tree(&tmp.0.to_string_lossy(), || Ok(())).is_err());
    }
    let started = Instant::now();
    sessions.stop_all();
    assert!(started.elapsed() < Duration::from_secs(5));
    if !close_first {
        assert!(!sessions.list()[0].running, "shutdown returned before the agent exited");
        assert!(sessions.list()[0].stopped);
    }
    wait_for("helper ends", || unsafe { libc::kill(pid, 0) != 0 });
}

#[test]
fn codex_receives_a_markdown_list_as_a_prompt_after_the_option_separator() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = temp("codex-prompt");
    let bin = tmp.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let path = bin.join("codex");
    // A stand-in CLI with Codex's option boundary: only the prompt may follow `--`.
    std::fs::write(&path, "#!/bin/sh\n[ \"$#\" = 3 ] && [ \"$1\" = --no-daemon ] && [ \"$2\" = -- ] || exit 2\nprintf 'prompt:%s\\n' \"$3\"\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sessions = Arc::new(Sessions::default());
    let task = "- 修复登录错误\n- 添加回归测试";
    let launch = agent::launch(agent::kind("codex").unwrap(), task, None, &tmp.0, &tmp.0, &env_with(&bin), (80, 24)).unwrap();
    let info = sessions.spawn(launch, meta(&tmp.0)).unwrap();
    wait_for("codex exits", || !sessions.list()[0].running);
    assert_eq!(sessions.list()[0].exit_code, Some(0));
    wait_for("codex prompt", || output(&sessions, &info.id).contains("prompt:- 修复登录错误\r\n- 添加回归测试"));
}

fn saved_record(project: &Path, tree: &Path) -> serde_json::Value {
    json!({
        "id": "saved", "project": project.to_string_lossy(), "tree": tree.to_string_lossy(),
        "branch": "agent/fix-login", "agent": "codex", "task": "original task",
        "title": "Fix login", "startedAt": 1, "lastOutputAt": 2,
        "bellAt": null, "inputAt": null, "running": true, "exitCode": 3, "stopped": false
    })
}

#[test]
fn saved_sessions_restore_as_stopped_without_a_live_terminal_and_close_forgets_them() {
    let tmp = temp("restore");
    let path = tmp.0.join("agent-sessions.json");
    std::fs::write(&path, serde_json::to_vec(&vec![saved_record(&tmp.0, &tmp.0)]).unwrap()).unwrap();
    let sessions = Sessions::with_path(path.clone());
    let info = &sessions.list()[0];
    assert_eq!(info.task, "original task");
    assert_eq!(info.title.as_deref(), Some("Fix login"));
    assert!(!info.running && info.stopped);
    assert_eq!(info.exit_code, None);
    assert_eq!(sessions.read("saved", 0).unwrap(), (vec![], 0, 0));
    assert!(sessions.write("saved", b"no process", true).is_err());
    sessions.close("saved").unwrap();
    assert!(Sessions::with_path(path).list().is_empty());
}

#[test]
fn session_metadata_is_saved_on_spawn_and_exit_without_terminal_bytes_or_environment() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = temp("persist");
    let path = tmp.0.join("agent-sessions.json");
    let bin = fake_agent(&tmp.0, "codex");
    let mut env = env_with(&bin);
    env.insert("OPENAI_API_KEY".into(), "test-secret-environment".into());
    let sessions = Arc::new(Sessions::with_path(path.clone()));
    let launch = agent::launch(agent::kind("codex").unwrap(), "original task", None, &tmp.0, &tmp.0, &env, (80, 24)).unwrap();
    let info = sessions.spawn(launch, Meta { project: "p".into(), tree: tmp.0.to_string_lossy().into_owned(), branch: None, agent: "codex".into(), task: "original task".into() }).unwrap();
    wait_for("ready", || output(&sessions, &info.id).contains("ready"));
    let saved: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["id"], info.id);
    assert_eq!(saved[0]["running"], true);
    sessions.stop_all();
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("test-secret-environment") && !raw.contains("agent args:") && !raw.contains("ready"));
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    let saved: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
    assert_eq!(saved[0]["running"], false);
    assert_eq!(saved[0]["stopped"], true);
    let restored = Sessions::with_path(path);
    assert_eq!(restored.list()[0].id, info.id);
    assert!(restored.list()[0].stopped);
}

#[test]
fn failed_resume_keeps_the_original_record_and_concurrent_resume_starts_only_once() {
    let tmp = temp("resume");
    let path = tmp.0.join("agent-sessions.json");
    std::fs::write(&path, serde_json::to_vec(&vec![saved_record(&tmp.0, &tmp.0)]).unwrap()).unwrap();
    let bin = fake_agent(&tmp.0, "codex");
    let sessions = Arc::new(Sessions::with_path(path.clone()));
    let env = env_with(&bin);
    assert!(sessions.resume("saved", |_| Err(anyhow::anyhow!("validation failed"))).is_err());
    let mut missing = agent::resume_launch(agent::kind("codex").unwrap(), &tmp.0, &tmp.0, &env, (80, 24)).unwrap();
    missing.program = tmp.0.join("missing-codex");
    assert!(sessions.resume("saved", |_| Ok(missing)).is_err());
    assert_eq!(sessions.list()[0].id, "saved");
    assert_eq!(Sessions::with_path(path).list()[0].task, "original task");

    let barrier = Arc::new(std::sync::Barrier::new(2));
    let jobs: Vec<_> = (0..2).map(|_| {
        let sessions = sessions.clone();
        let barrier = barrier.clone();
        let tree = tmp.0.clone();
        let env = env.clone();
        std::thread::spawn(move || {
            barrier.wait();
            sessions.resume("saved", |_| agent::resume_launch(agent::kind("codex").unwrap(), &tree, &tree, &env, (80, 24)))
        })
    }).collect();
    let results: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
    let info = results.into_iter().find_map(Result::ok).unwrap();
    assert_ne!(info.id, "saved");
    assert_eq!(info.task, "original task");
    assert_eq!(sessions.list().len(), 1);
    wait_for("native history picker", || output(&sessions, &info.id).contains("agent args:[--no-daemon resume]"));
    assert!(!output(&sessions, &info.id).contains("original task"));
    assert!(sessions.resume(&info.id, |_| unreachable!()).is_err());
    sessions.stop_all();
}

#[test]
fn resume_rejects_a_removed_worktree_without_dropping_its_record() {
    let tmp = temp("resume-missing");
    let main = repo(&tmp.0);
    let config = tmp.0.join("config.json");
    std::fs::write(&config, serde_json::to_vec(&json!({"projects": [{"path": main.to_string_lossy()}]})).unwrap()).unwrap();
    std::fs::write(tmp.0.join("agent-sessions.json"), serde_json::to_vec(&vec![saved_record(&main, &tmp.0.join("gone"))]).unwrap()).unwrap();
    let state = State::with_config(config);
    let err = dispatch(&state, "agentResume", json!({"session": "saved"})).unwrap_err().to_string();
    assert!(err.contains("gone"), "{err}");
    assert_eq!(state.agents.list()[0].id, "saved");
}

#[test]
fn quitting_prevents_pending_launches_and_resumes_from_starting_after_the_shutdown_snapshot() {
    let tmp = temp("quit-launch");
    let bin = fake_agent(&tmp.0, "codex");
    let sessions = Arc::new(Sessions::default());
    sessions.stop_all();
    let launch = agent::launch(agent::kind("codex").unwrap(), "", None, &tmp.0, &tmp.0, &env_with(&bin), (80, 24)).unwrap();
    assert!(sessions.spawn(launch, meta(&tmp.0)).is_err());
    assert!(sessions.resume("saved", |_| unreachable!()).is_err());
    assert!(sessions.list().is_empty());
}

#[test]
fn resume_templates_use_native_history_without_resubmitting_tasks_or_guessing_opencode_flags() {
    assert_eq!(agent::kind("codex").unwrap().resume_args().unwrap(), vec!["--no-daemon", "resume"]);
    assert_eq!(agent::kind("claude").unwrap().resume_args().unwrap(), vec!["--resume"]);
    assert!(agent::kind("opencode").unwrap().resume_args().unwrap_err().to_string().contains("OpenCode"));
}

#[test]
fn an_active_agents_clean_merged_worktree_cannot_be_listed_or_removed_for_cleanup() {
    let tmp = temp("cleanup-active-agent");
    let main = repo(&tmp.0);
    let head = git(&main, &["rev-parse", "HEAD"]);
    let tree = agent::create_worktree(&main, "agent/clean", &head).unwrap();
    let state = State::with_config(tmp.0.join("config.json"));
    let id = main.to_string_lossy().into_owned();
    dispatch(&state, "addPath", json!({"path": id})).unwrap();
    let candidates = || dispatch(&state, "cleanupCandidates", json!({"id": id})).unwrap();
    let contains_tree = |candidates: &serde_json::Value| candidates.as_array().unwrap().iter().any(|c| c["path"] == tree);
    assert!(contains_tree(&candidates()), "the clean ancestor worktree should otherwise qualify");
    let bin = fake_agent(&tmp.0, "codex");
    let launch = agent::launch(agent::kind("codex").unwrap(), "", None, Path::new(&tree), &main, &env_with(&bin), (80, 24)).unwrap();
    let info = state.agents.spawn(launch, Meta { project: id.clone(), tree: tree.clone(), branch: Some("agent/clean".into()), agent: "codex".into(), task: String::new() }).unwrap();
    wait_for("ready", || output(&state.agents, &info.id).contains("ready"));
    assert_eq!(git(Path::new(&tree), &["status", "--porcelain"]), "");
    assert!(!contains_tree(&candidates()), "running agents must be excluded even when clean");
    let remove = || dispatch(&state, "removeWorktree", json!({"id": id, "path": tree, "head": head, "deleteBranch": true}));
    let err = remove().unwrap_err().to_string();
    assert!(err.contains("agent") && err.contains(&tree), "{err}");
    assert!(Path::new(&tree).is_dir());
    state.agents.stop(&info.id).unwrap();
    wait_for("agent stops", || !state.agents.list()[0].running);
    assert!(contains_tree(&candidates()));
    remove().unwrap();
    assert!(!Path::new(&tree).exists());
}

#[test]
fn a_worktree_removal_holds_the_session_mutation_guard_until_it_finishes() {
    let tmp = temp("cleanup-start-race");
    let bin = fake_agent(&tmp.0, "codex");
    let sessions = Arc::new(Sessions::default());
    let (entered, removing) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let remover = {
        let sessions = sessions.clone();
        let tree = tmp.0.clone();
        std::thread::spawn(move || sessions.with_idle_tree(&tree.to_string_lossy(), || {
            entered.send(()).unwrap();
            wait_release.recv().unwrap();
            Ok(())
        }))
    };
    removing.recv().unwrap();
    let (spawned, result) = std::sync::mpsc::channel();
    let starter = {
        let sessions = sessions.clone();
        let tree = tmp.0.clone();
        std::thread::spawn(move || {
            let launch = agent::launch(agent::kind("codex").unwrap(), "", None, &tree, &tree, &env_with(&bin), (80, 24)).unwrap();
            let info = sessions.spawn(launch, meta(&tree));
            spawned.send(info.is_ok()).unwrap();
        })
    };
    assert!(matches!(result.recv_timeout(Duration::from_millis(100)), Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
    release.send(()).unwrap();
    remover.join().unwrap().unwrap();
    assert!(result.recv_timeout(Duration::from_secs(5)).unwrap());
    starter.join().unwrap();
    sessions.stop_all();
}
