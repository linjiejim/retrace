//! End-to-end checks against throwaway repositories built with the real `git`.

use retrace_lib::core::{api::dispatch, State};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn sh(dir: &Path, args: &[&str]) -> String {
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

fn write(dir: &Path, file: &str, content: &str) {
    let p = dir.join(file);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) -> String {
    write(dir, file, content);
    sh(dir, &["add", "-A"]);
    sh(dir, &["commit", "-q", "-m", msg]);
    sh(dir, &["rev-parse", "HEAD"])
}

struct Fixture {
    _tmp: TempDir,
    state: Arc<State>,
    main: PathBuf,
    wt_open: PathBuf,
    wt_squash: PathBuf,
}

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> Fixture {
    let base = std::env::temp_dir().join(format!("retrace-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();
    let main = base.join("repo");
    std::fs::create_dir_all(&main).unwrap();
    sh(&main, &["init", "-q", "-b", "main"]);
    commit(&main, "README.md", "hello\n", "init");
    commit(&main, "src/lib.rs", "pub fn a() {}\n", "add lib");

    // merged with a merge commit
    sh(&main, &["switch", "-q", "-c", "feat/merged"]);
    commit(&main, "src/merged.rs", "one\n", "merged 1");
    commit(&main, "src/merged.rs", "one\ntwo\n", "merged 2");
    sh(&main, &["switch", "-q", "main"]);
    sh(&main, &["merge", "-q", "--no-ff", "-m", "Merge feat/merged", "feat/merged"]);

    // squash-merged
    sh(&main, &["switch", "-q", "-c", "feat/squash"]);
    commit(&main, "src/squash.rs", "s1\n", "squash 1");
    commit(&main, "src/squash.rs", "s1\ns2\n", "squash 2");
    sh(&main, &["switch", "-q", "main"]);
    sh(&main, &["merge", "-q", "--squash", "feat/squash"]);
    sh(&main, &["commit", "-q", "-m", "feat: squash (#2)"]);

    // open worktree with one commit and uncommitted work
    let wt_open = base.join("wt-open");
    sh(&main, &["worktree", "add", "-q", "-b", "feat/open", wt_open.to_str().unwrap()]);
    commit(&wt_open, "src/open.rs", "o1\n", "open 1");
    write(&wt_open, "src/lib.rs", "pub fn a() {}\npub fn b() {}\n");
    write(&wt_open, "src/staged.rs", "staged\n");
    sh(&wt_open, &["add", "src/staged.rs"]);
    write(&wt_open, "notes/todo.md", "todo\n");

    let wt_squash = base.join("wt-squash");
    sh(&main, &["worktree", "add", "-q", wt_squash.to_str().unwrap(), "feat/squash"]);

    let state = State::with_config(base.join("config.json"));
    Fixture { _tmp: TempDir(base), state, main, wt_open, wt_squash }
}

fn call(f: &Fixture, cmd: &str, args: Value) -> Value {
    dispatch(&f.state, cmd, args).unwrap_or_else(|e| panic!("{cmd}: {e:#}"))
}

#[test]
fn adding_a_linked_worktree_adds_its_main_repository() {
    let f = fixture("add");
    let added = call(&f, "addPath", json!({ "path": f.wt_open }));
    assert_eq!(added["added"][0]["id"], json!(f.main.to_string_lossy()));
    let again = call(&f, "addPath", json!({ "path": f.main }));
    assert_eq!(again["added"].as_array().unwrap().len(), 0, "no duplicates");

    let parent = f.main.parent().unwrap();
    let scan = call(&f, "addPath", json!({ "path": parent }));
    let candidates = scan["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 1, "worktrees of the same repo collapse into one candidate");
    assert_eq!(candidates[0]["added"], json!(true));
}

#[test]
fn overview_statuses_and_integration() {
    let f = fixture("status");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();

    let ov = call(&f, "overview", json!({ "id": id }));
    assert_eq!(ov["trunk"]["name"], "main");
    assert_eq!(ov["trunk"]["tip"], json!(sh(&f.main, &["rev-parse", "main"])));
    assert_eq!(ov["trees"].as_array().unwrap().len(), 3);
    assert_eq!(ov["trees"][0]["isMain"], json!(true));

    let statuses = call(&f, "treeStatuses", json!({ "id": id }));
    let find = |p: &Path| statuses.as_array().unwrap().iter().find(|s| s["path"] == json!(p.to_string_lossy())).unwrap().clone();

    let main = find(&f.main);
    assert_eq!(main["files"], 0);
    assert!(main["trunk"].is_null(), "the main tree on the trunk has nothing to compare");

    let open = find(&f.wt_open);
    assert_eq!(open["files"], 3);
    assert_eq!(open["staged"], 1);
    assert_eq!(open["unstaged"], 1);
    assert_eq!(open["untracked"], 1);
    assert_eq!(open["trunk"]["ahead"], 1);
    assert_eq!(open["trunk"]["behind"], 0);
    assert_eq!(open["trunk"]["integration"], "none");

    let squash = find(&f.wt_squash);
    assert_eq!(squash["files"], 0);
    assert_eq!(squash["trunk"]["ahead"], 2);
    assert_eq!(squash["trunk"]["integration"], "squash");

    let merged_tip = sh(&f.main, &["rev-parse", "feat/merged"]);
    let cmp = call(&f, "compare", json!({ "id": id, "tip": merged_tip }));
    assert_eq!(cmp["ahead"], 0);
    assert_eq!(cmp["integration"], "ancestor");
}

#[test]
fn history_pins_trunk_and_inserts_uncommitted_row() {
    let f = fixture("history");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let trunk = sh(&f.main, &["rev-parse", "main"]);
    let head = sh(&f.wt_open, &["rev-parse", "HEAD"]);

    let page = call(&f, "history", json!({ "id": id, "trunkTip": trunk, "tip": head, "worktreeHead": head, "count": 100 }));
    let rows = page["rows"].as_array().unwrap();
    assert_eq!(rows[0]["id"], "WORKTREE");
    assert_eq!(rows[1]["id"], json!(head));
    assert_eq!(rows[1]["col"], 1, "the branch commit sits right of the trunk");
    let chain: Vec<String> = sh(&f.main, &["rev-list", "--first-parent", "main"]).lines().map(str::to_string).collect();
    for r in rows {
        if chain.contains(&r["id"].as_str().unwrap().to_string()) {
            assert_eq!(r["col"], 0, "trunk commit {} must be in column 0", r["subject"]);
        }
    }
    let merged = rows.iter().find(|r| r["subject"] == "merged 2").unwrap();
    assert_ne!(merged["col"], 0);
}

#[test]
fn changes_and_file_pairs() {
    let f = fixture("changes");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();

    // merge commit: compared with its first parent
    let merge = sh(&f.main, &["rev-parse", "main~1"]);
    let files = call(&f, "changes", json!({ "id": id, "target": { "kind": "commit", "hash": merge } }));
    assert_eq!(files[0]["path"], "src/merged.rs");
    assert_eq!(files[0]["status"], "added");
    assert_eq!(files[0]["additions"], 2);

    // root commit
    let root = sh(&f.main, &["rev-list", "--max-parents=0", "main"]);
    let files = call(&f, "changes", json!({ "id": id, "target": { "kind": "commit", "hash": root } }));
    assert_eq!(files[0]["path"], "README.md");

    // uncommitted
    let tree = f.wt_open.to_string_lossy().to_string();
    let files = call(&f, "changes", json!({ "id": id, "target": { "kind": "worktree", "tree": tree } }));
    let by_path = |p: &str| files.as_array().unwrap().iter().find(|x| x["path"] == p).unwrap().clone();
    assert_eq!(by_path("src/lib.rs")["status"], "modified");
    assert_eq!(by_path("src/staged.rs")["status"], "added");
    assert_eq!(by_path("notes/todo.md")["status"], "untracked");
    assert_eq!(by_path("notes/todo.md")["additions"], 1);

    let pair = call(&f, "filePair", json!({ "id": id, "target": { "kind": "worktree", "tree": tree }, "path": "src/lib.rs" }));
    assert_eq!(pair["old"]["text"], "pub fn a() {}\n");
    assert_eq!(pair["new"]["text"], "pub fn a() {}\npub fn b() {}\n");

    // compare a branch with the trunk
    let files = call(&f, "changes", json!({ "id": id, "target": { "kind": "compare", "base": "main", "tip": "feat/open" } }));
    assert_eq!(files.as_array().unwrap().len(), 1);
    assert_eq!(files[0]["path"], "src/open.rs");
    let pair = call(&f, "filePair", json!({ "id": id, "target": { "kind": "compare", "base": "main", "tip": "feat/open" }, "path": "src/open.rs" }));
    assert!(pair["old"].is_null());
    assert_eq!(pair["new"]["text"], "o1\n");
}

#[test]
fn rejects_paths_and_revisions_outside_the_project() {
    let f = fixture("guard");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    assert!(dispatch(&f.state, "overview", json!({ "id": "/tmp" })).is_err());
    assert!(dispatch(&f.state, "changes", json!({ "id": id, "target": { "kind": "worktree", "tree": "/tmp" } })).is_err());
    assert!(dispatch(&f.state, "commit", json!({ "id": id, "hash": "--output=/tmp/x" })).is_err());
    assert!(dispatch(&f.state, "filePair", json!({ "id": id, "target": { "kind": "commit", "hash": "HEAD" }, "path": "../etc/passwd" })).is_err());
}

#[test]
fn reads_never_take_the_index_lock() {
    let f = fixture("locks");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    // Touch a tracked file without changing it: porcelain `git diff` / a locking `git status` would
    // refresh the index for it. A later mtime makes the stat mismatch certain, not timing-dependent.
    let readme = std::fs::File::options().write(true).open(f.wt_open.join("README.md")).unwrap();
    readme.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
    drop(readme);
    let index = f.main.join(".git/worktrees/wt-open/index");
    let before = std::fs::metadata(&index).unwrap().modified().unwrap();
    call(&f, "treeStatuses", json!({ "id": id }));
    call(&f, "changes", json!({ "id": id, "target": { "kind": "worktree", "tree": f.wt_open.to_string_lossy() } }));
    let after = std::fs::metadata(&index).unwrap().modified().unwrap();
    assert_eq!(before, after, "the index must not be rewritten by reads");
    let files = call(&f, "changes", json!({ "id": id, "target": { "kind": "worktree", "tree": f.wt_open.to_string_lossy() } }));
    assert!(files.as_array().unwrap().iter().all(|x| x["path"] != "README.md"), "a touched but unchanged file is not a change");
}

fn loose_objects(git_dir: &Path) -> usize {
    let objects = git_dir.join("objects");
    std::fs::read_dir(&objects)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().len() == 2)
        .map(|e| std::fs::read_dir(e.path()).map(|d| d.count()).unwrap_or(0))
        .sum()
}

#[test]
fn integration_checks_write_no_objects() {
    let f = fixture("objects");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let before = loose_objects(&f.main.join(".git"));
    let statuses = call(&f, "treeStatuses", json!({ "id": id }));
    // The squash check really ran (it needs merge-tree) and still found the answer.
    let squash = statuses.as_array().unwrap().iter().find(|s| s["path"] == json!(f.wt_squash.to_string_lossy())).unwrap();
    assert_eq!(squash["trunk"]["integration"], "squash");
    assert_eq!(loose_objects(&f.main.join(".git")), before, "merge simulation must not add objects to the repository");
}

#[test]
fn worktree_reads_stay_inside_the_tree() {
    let f = fixture("symlink");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    commit(&f.wt_open, "linkdir/file.txt", "tracked\n", "add linkdir");
    let outside = f.main.parent().unwrap().join("outside");
    write(&outside, "file.txt", "secret\n");
    std::fs::remove_dir_all(f.wt_open.join("linkdir")).unwrap();
    std::os::unix::fs::symlink(&outside, f.wt_open.join("linkdir")).unwrap();

    let tree = f.wt_open.to_string_lossy().to_string();
    let pair = call(&f, "filePair", json!({ "id": id, "target": { "kind": "worktree", "tree": tree }, "path": "linkdir/file.txt" }));
    assert_eq!(pair["old"]["text"], "tracked\n");
    assert!(pair["new"].is_null(), "a file behind a symlinked folder is outside the worktree");

    let escape = format!("{}/../outside", f.main.to_string_lossy());
    let err = dispatch(&f.state, "open", json!({ "id": id, "path": escape, "with": "finder" })).unwrap_err();
    assert!(format!("{err:#}").contains("只能打开"), "{err:#}");
}

#[test]
fn summary_links_github_without_credentials() {
    let f = fixture("summary");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    assert!(call(&f, "projectSummary", json!({ "id": id }))["webUrl"].is_null(), "no remote, no link");

    sh(&f.main, &["remote", "add", "origin", "https://x-access-token:secret@github.com/o/r.git"]);
    let s = call(&f, "projectSummary", json!({ "id": id }));
    assert_eq!(s["webUrl"], "https://github.com/o/r");
    assert!(!s.to_string().contains("secret"));

    std::fs::rename(&f.main, f.main.with_file_name("moved")).unwrap();
    let s = call(&f, "projectSummary", json!({ "id": id }));
    assert_eq!(s["missing"], json!(true));
    assert!(s["webUrl"].is_null());
}

#[test]
fn repository_without_commits() {
    let base = std::env::temp_dir().join(format!("retrace-test-unborn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();
    let _tmp = TempDir(base.clone());
    let repo = base.join("fresh");
    std::fs::create_dir_all(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    write(&repo, "hello.txt", "hi\n");
    let state = State::with_config(base.join("config.json"));
    dispatch(&state, "addPath", json!({ "path": repo })).unwrap();
    let id = repo.to_string_lossy().to_string();

    let ov = dispatch(&state, "overview", json!({ "id": id })).unwrap();
    assert!(ov["trees"][0]["head"].is_null());
    assert!(ov["trunk"].is_null());
    let statuses = dispatch(&state, "treeStatuses", json!({ "id": id })).unwrap();
    assert_eq!(statuses[0]["untracked"], 1);
    let page = dispatch(&state, "history", json!({ "id": id, "count": 100 })).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 0);
    let files = dispatch(&state, "changes", json!({ "id": id, "target": { "kind": "worktree", "tree": id } })).unwrap();
    assert_eq!(files[0]["path"], "hello.txt");
}

#[test]
fn squash_detection_survives_a_colon_in_the_repository_path() {
    let f = fixture("colon:path");
    assert!(f.main.to_string_lossy().contains(':'));
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let statuses = call(&f, "treeStatuses", json!({ "id": id }));
    let squash = statuses.as_array().unwrap().iter().find(|s| s["path"] == json!(f.wt_squash.to_string_lossy())).unwrap();
    assert_eq!(squash["trunk"]["integration"], "squash");
}

#[test]
fn history_pages_match_one_long_page() {
    let f = fixture("pages");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let trunk = sh(&f.main, &["rev-parse", "main"]);
    let head = sh(&f.wt_open, &["rev-parse", "HEAD"]);
    let q = |offset: usize, count: usize| {
        call(&f, "history", json!({ "id": id, "trunkTip": trunk, "tip": head, "worktreeHead": head, "offset": offset, "count": count }))
    };
    let whole = q(0, 100);
    let first = q(0, 3);
    let rest = q(3, 100);
    assert_eq!(first["hasMore"], json!(true));
    assert_eq!(rest["hasMore"], json!(false));
    let mut paged = first["rows"].as_array().unwrap().clone();
    paged.extend(rest["rows"].as_array().unwrap().iter().cloned());
    assert_eq!(&paged, whole["rows"].as_array().unwrap(), "paging must not change rows or lanes");
}

#[test]
fn other_branches_join_the_graph_on_request() {
    let f = fixture("branches");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let trunk = sh(&f.main, &["rev-parse", "main"]);
    sh(&f.main, &["branch", "side", "main~1"]);
    sh(&f.main, &["switch", "-q", "side"]);
    let side = commit(&f.main, "side.txt", "s\n", "side work");
    sh(&f.main, &["switch", "-q", "main"]);
    let ids = |v: &Value| v["rows"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let plain = call(&f, "history", json!({ "id": id, "trunkTip": trunk, "tip": trunk }));
    assert!(!ids(&plain).contains(&side));
    let all = call(&f, "history", json!({ "id": id, "trunkTip": trunk, "tip": trunk, "allBranches": true }));
    assert!(ids(&all).contains(&side));
    let open = sh(&f.wt_open, &["rev-parse", "HEAD"]);
    assert!(ids(&all).contains(&open), "worktree branches are local branches too");
}

#[test]
fn untracked_folders_are_counted_file_by_file() {
    let f = fixture("untracked");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    for i in 0..5 {
        write(&f.wt_open, &format!("newdir/sub/f{i}.txt"), "x\n");
    }
    let statuses = call(&f, "treeStatuses", json!({ "id": id }));
    let open = statuses.as_array().unwrap().iter().find(|s| s["path"] == json!(f.wt_open.to_string_lossy())).unwrap();
    // staged.rs + lib.rs + notes/todo.md + 5 files in newdir
    assert_eq!(open["untracked"], 6);
    assert_eq!(open["files"], 8);
    let files = call(&f, "changes", json!({ "id": id, "target": { "kind": "worktree", "tree": f.wt_open.to_string_lossy() } }));
    assert_eq!(files.as_array().unwrap().len(), 8, "badge and list agree");
}

#[test]
fn patch_covers_commits_and_untracked_files() {
    let f = fixture("patch");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let merge = sh(&f.main, &["rev-parse", "main~1"]);
    let p = call(&f, "patch", json!({ "id": id, "target": { "kind": "commit", "hash": merge } }));
    assert!(p["patch"].as_str().unwrap().contains("diff --git a/src/merged.rs b/src/merged.rs"));
    assert_eq!(p["truncated"], json!(false));
    let tree = f.wt_open.to_string_lossy().to_string();
    let p = call(&f, "patch", json!({ "id": id, "target": { "kind": "worktree", "tree": tree } }));
    let text = p["patch"].as_str().unwrap();
    assert!(text.contains("+pub fn b() {}"), "{text}");
    assert!(text.contains("diff --git a/notes/todo.md b/notes/todo.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/todo.md\n@@ -0,0 +1,1 @@\n+todo\n"), "{text}");
}

#[test]
fn cleanup_lists_merged_clean_trees_and_removes_them_safely() {
    let f = fixture("cleanup");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    // A tree on a branch merged with a merge commit, holding an ignored .env.
    let wt_merged = f.main.parent().unwrap().join("wt-merged");
    sh(&f.main, &["worktree", "add", "-q", wt_merged.to_str().unwrap(), "feat/merged"]);
    std::fs::write(f.main.join(".git/info/exclude"), ".env\nnode_modules/\n").unwrap();
    write(&wt_merged, ".env", "SECRET=1\n");
    write(&wt_merged, "node_modules/x/index.js", "1\n");
    write(&wt_merged, "packages/web/node_modules/y/index.js", "1\n");

    let list = call(&f, "cleanupCandidates", json!({ "id": id }));
    let paths: Vec<String> = list.as_array().unwrap().iter().map(|c| c["path"].as_str().unwrap().to_string()).collect();
    assert!(paths.contains(&f.wt_squash.to_string_lossy().to_string()));
    assert!(paths.contains(&wt_merged.to_string_lossy().to_string()));
    assert!(!paths.contains(&f.wt_open.to_string_lossy().to_string()), "unmerged and dirty trees are not candidates");
    let merged = list.as_array().unwrap().iter().find(|c| c["path"] == json!(wt_merged.to_string_lossy())).unwrap();
    assert_eq!(merged["integration"], "ancestor");
    assert_eq!(merged["notableIgnored"], json!([".env"]), "node_modules (also nested) is regenerable, .env is not");
    assert_eq!(merged["recent"], json!(true));

    // Re-verification: new work after listing blocks the removal.
    let squash = list.as_array().unwrap().iter().find(|c| c["path"] == json!(f.wt_squash.to_string_lossy())).unwrap().clone();
    write(&f.wt_squash, "late.txt", "new\n");
    let err = dispatch(&f.state, "removeWorktree", json!({ "id": id, "path": squash["path"], "head": squash["head"], "deleteBranch": true })).unwrap_err();
    assert!(format!("{err:#}").contains("未提交"), "{err:#}");
    assert!(f.wt_squash.exists());
    std::fs::remove_file(f.wt_squash.join("late.txt")).unwrap();

    let out = call(&f, "removeWorktree", json!({ "id": id, "path": squash["path"], "head": squash["head"], "deleteBranch": true }));
    assert!(!f.wt_squash.exists());
    assert_eq!(out["branchDeleted"], json!(true), "squash-merged branches go too: `git branch -d` would refuse them");
    assert!(sh(&f.main, &["branch", "--list", "feat/squash"]).is_empty());

    // .env was listed; a second irreplaceable file appearing after the listing stops the removal.
    write(&wt_merged, ".env.local", "LATE=1\n");
    std::fs::write(f.main.join(".git/info/exclude"), ".env\n.env.local\nnode_modules/\n").unwrap();
    let err = dispatch(&f.state, "removeWorktree", json!({ "id": id, "path": merged["path"], "head": merged["head"], "acknowledgedIgnored": merged["notableIgnored"], "deleteBranch": true })).unwrap_err();
    assert!(format!("{err:#}").contains(".env.local"), "{err:#}");
    assert!(wt_merged.exists());
    std::fs::remove_file(wt_merged.join(".env.local")).unwrap();

    let out = call(&f, "removeWorktree", json!({ "id": id, "path": merged["path"], "head": merged["head"], "acknowledgedIgnored": merged["notableIgnored"], "deleteBranch": true }));
    assert!(!wt_merged.exists());
    assert_eq!((&out["branchDeleted"], &out["deletedBranch"]), (&json!(true), &json!("feat/merged")));
    assert!(sh(&f.main, &["branch", "--list", "feat/merged"]).is_empty());

    // The main tree and unknown paths are never removed.
    let main_head = sh(&f.main, &["rev-parse", "HEAD"]);
    assert!(dispatch(&f.state, "removeWorktree", json!({ "id": id, "path": id, "head": main_head, "deleteBranch": false })).is_err());
    assert!(f.main.exists());
}

#[test]
fn branches_without_a_worktree_are_judged_and_deleted_safely() {
    let f = fixture("branch-cleanup");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    // Squash-merged, then the trunk changed the same lines: only the patch-id check sees it's in.
    sh(&f.main, &["switch", "-q", "-c", "feat/stale"]);
    commit(&f.main, "src/stale.rs", "a\nb\n", "stale 1");
    let stale_tip = commit(&f.main, "src/stale.rs", "a\nb\nc\n", "stale 2");
    sh(&f.main, &["switch", "-q", "main"]);
    sh(&f.main, &["merge", "-q", "--squash", "feat/stale"]);
    sh(&f.main, &["commit", "-q", "-m", "feat: stale (#3)"]);
    commit(&f.main, "src/stale.rs", "a\nB\nc\n", "later edit");
    sh(&f.main, &["config", "branch.feat/stale.remote", "origin"]);
    // Still being worked on, a long-lived name, and one that never had a commit.
    sh(&f.main, &["switch", "-q", "-c", "feat/unmerged"]);
    commit(&f.main, "src/unmerged.rs", "u\n", "unmerged");
    sh(&f.main, &["switch", "-q", "main"]);
    sh(&f.main, &["branch", "develop", "main~1"]);
    sh(&f.main, &["branch", "feat/empty"]);
    // Changed lines the trunk later changed differently: the patch-id scan runs and finds no match,
    // also when the only difference is whitespace (a re-indent is not the same change).
    commit(&f.main, "src/ws.py", "def f():\n    x = 1\n", "ws base");
    sh(&f.main, &["switch", "-q", "-c", "feat/reindent"]);
    commit(&f.main, "src/ws.py", "def f():\n        x = 1\n", "reindent");
    sh(&f.main, &["switch", "-q", "main"]);
    commit(&f.main, "src/ws.py", "def f():\n  x = 1\n", "trunk reindent");
    // A remote whose main is the trunk; a merged feature branch tracking it (what
    // `git switch -c x origin/main` sets up) is still a feature branch.
    sh(&f.main, &["config", "remote.origin.url", "/nonexistent"]);
    sh(&f.main, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    sh(&f.main, &["update-ref", "refs/remotes/origin/main", "main"]);
    sh(&f.main, &["config", "branch.feat/merged.remote", "origin"]);
    sh(&f.main, &["config", "branch.feat/merged.merge", "refs/heads/main"]);
    // A setting written without a value means true; it must come back as true.
    let cfg = f.main.join(".git/config");
    let mut text = std::fs::read_to_string(&cfg).unwrap();
    text.push_str("[branch \"feat/stale\"]\n\tflag\n");
    std::fs::write(&cfg, text).unwrap();

    let list = call(&f, "branchStatuses", json!({ "id": id }));
    let get = |list: &Value, name: &str| list.as_array().unwrap().iter().find(|b| b["name"] == name).cloned();
    let mut names: Vec<&str> = list.as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, vec!["develop", "feat/empty", "feat/merged", "feat/reindent", "feat/stale", "feat/unmerged"], "no trunk, no checked-out branches");
    assert_eq!(get(&list, "feat/reindent").unwrap()["integration"], "none", "whitespace counts");
    assert_eq!(sh(&f.main, &["rev-parse", "--abbrev-ref", "feat/merged@{upstream}"]), "origin/main");
    let merged = get(&list, "feat/merged").unwrap();
    assert_eq!((merged["integration"].as_str(), merged["ahead"].as_u64(), merged["neverCommitted"].as_bool()), (Some("ancestor"), Some(0), Some(false)));
    assert_eq!(get(&list, "feat/stale").unwrap()["integration"], "squash");
    let unmerged = get(&list, "feat/unmerged").unwrap();
    assert_eq!((unmerged["integration"].as_str(), unmerged["ahead"].as_u64()), (Some("none"), Some(1)));
    assert_eq!(get(&list, "develop").unwrap()["protected"], json!(true));
    let empty = get(&list, "feat/empty").unwrap();
    assert_eq!((empty["neverCommitted"].as_bool(), empty["recent"].as_bool()), (Some(true), Some(true)));

    // Every guard is checked again on delete; nothing is deleted when one fails.
    let delete = |name: &str, tip: &str| dispatch(&f.state, "deleteBranch", json!({ "id": id, "name": name, "tip": tip }));
    let tip_of = |name: &str| sh(&f.main, &["rev-parse", name]);

    // A branch being rebased in a worktree shows there as a detached HEAD, but it's in use.
    let wt_rebase = f.main.parent().unwrap().join("wt-rebase");
    sh(&f.main, &["worktree", "add", "-q", wt_rebase.to_str().unwrap(), "feat/stale"]);
    let rebase = Command::new("git").args(["rebase", "main"]).current_dir(&wt_rebase).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_COMMITTER_NAME", "Test").env("GIT_COMMITTER_EMAIL", "test@example.com").output().unwrap();
    assert!(!rebase.status.success(), "the rebase stops on a conflict");
    assert!(get(&call(&f, "branchStatuses", json!({ "id": id })), "feat/stale").is_none());
    let err = delete("feat/stale", &stale_tip).unwrap_err();
    assert!(format!("{err:#}").contains("rebase"), "{err:#}");
    sh(&wt_rebase, &["rebase", "--abort"]);
    sh(&f.main, &["worktree", "remove", wt_rebase.to_str().unwrap()]);
    assert!(get(&call(&f, "branchStatuses", json!({ "id": id })), "feat/stale").is_some());

    // Removing a merged worktree keeps a long-lived branch, with the reason.
    let wt_develop = f.main.parent().unwrap().join("wt-develop");
    sh(&f.main, &["worktree", "add", "-q", wt_develop.to_str().unwrap(), "develop"]);
    let out = call(&f, "removeWorktree", json!({ "id": id, "path": wt_develop, "head": tip_of("develop"), "deleteBranch": true }));
    assert_eq!(out["branchDeleted"], json!(false));
    assert!(out["branchKeptReason"].as_str().unwrap().contains("长期"), "{out}");
    assert!(!sh(&f.main, &["branch", "--list", "develop"]).is_empty());
    let err = delete("feat/unmerged", &tip_of("feat/unmerged")).unwrap_err();
    assert!(format!("{err:#}").contains("合并"), "{err:#}");
    assert!(delete("develop", &tip_of("develop")).is_err());
    assert!(delete("main", &tip_of("main")).is_err());
    assert!(delete("feat/squash", &tip_of("feat/squash")).is_err(), "checked out in a worktree");
    assert!(delete("feat/merged", &tip_of("main")).is_err(), "the tip moved since it was listed");
    assert!(delete("--force", &tip_of("main")).is_err());
    for b in ["feat/unmerged", "develop", "main", "feat/squash", "feat/merged"] {
        assert!(!sh(&f.main, &["branch", "--list", b]).is_empty(), "{b} survived");
    }

    // Kept by the user: listed as kept, refused on delete until it's released.
    call(&f, "keepBranch", json!({ "id": id, "name": "feat/merged", "keep": true }));
    assert_eq!(get(&call(&f, "branchStatuses", json!({ "id": id })), "feat/merged").unwrap()["kept"], json!(true));
    assert!(delete("feat/merged", &tip_of("feat/merged")).is_err());
    call(&f, "keepBranch", json!({ "id": id, "name": "feat/merged", "keep": false }));
    delete("feat/merged", &tip_of("feat/merged")).unwrap();

    // Squash-merged: deleted with its settings, and Undo brings it back at the same commit.
    delete("feat/stale", &stale_tip).unwrap();
    assert!(sh(&f.main, &["branch", "--list", "feat/merged", "feat/stale"]).is_empty());
    assert!(!sh(&f.main, &["config", "--list"]).contains("branch.feat/stale."));
    call(&f, "restoreBranch", json!({ "id": id, "name": "feat/stale" }));
    assert_eq!(tip_of("feat/stale"), stale_tip);
    assert_eq!(sh(&f.main, &["config", "branch.feat/stale.remote"]), "origin", "its settings come back too");
    assert_eq!(sh(&f.main, &["config", "--bool", "branch.feat/stale.flag"]), "true");
    assert!(dispatch(&f.state, "restoreBranch", json!({ "id": id, "name": "feat/stale" })).is_err(), "restored once");
    assert!(dispatch(&f.state, "restoreBranch", json!({ "id": id, "name": "feat/new" })).is_err(), "never deleted here");
}

#[test]
fn the_trunks_own_branch_is_never_offered_whatever_the_trunk_is_called() {
    let f = fixture("trunk-names");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    // A fork: the trunk is another remote's branch, and its local copy is checked out nowhere.
    sh(&f.main, &["branch", "integration"]);
    sh(&f.main, &["update-ref", "refs/remotes/upstream/integration", "main"]);
    call(&f, "setTrunk", json!({ "id": id, "branch": "upstream/integration" }));
    let list = call(&f, "branchStatuses", json!({ "id": id }));
    assert!(list.as_array().unwrap().iter().all(|b| b["name"] != "integration"), "{list}");
    let tip = sh(&f.main, &["rev-parse", "integration"]);
    assert!(dispatch(&f.state, "deleteBranch", json!({ "id": id, "name": "integration", "tip": tip })).is_err());
    assert!(!sh(&f.main, &["branch", "--list", "integration"]).is_empty());
}

/// 2500 commits with a merged side branch every 100: big enough that history is read from git in
/// several `--skip` chunks.
fn long_history(name: &str) -> (TempDir, PathBuf) {
    use std::io::Write;
    let base = std::env::temp_dir().join(format!("retrace-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let base = std::fs::canonicalize(&base).unwrap();
    let repo = base.join("long");
    std::fs::create_dir_all(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    let mut stream = String::new();
    let mut mark = 0;
    let mut head = 0;
    let mut t = 1_600_000_000u64;
    let mut commit = |stream: &mut String, r#ref: &str, msg: &str, parents: &[usize], t: u64| -> usize {
        mark += 1;
        stream.push_str(&format!("commit {}\nmark :{}\nauthor T <t@t> {} +0000\ncommitter T <t@t> {} +0000\ndata {}\n{}\n", r#ref, mark, t, t, msg.len(), msg));
        if let Some(p) = parents.first() {
            stream.push_str(&format!("from :{p}\n"));
        }
        for p in parents.iter().skip(1) {
            stream.push_str(&format!("merge :{p}\n"));
        }
        stream.push_str(&format!("M 100644 inline f{}.txt\ndata 2\n{}\n\n", mark % 7, mark % 10));
        mark
    };
    for n in 0..2500 {
        t += 60;
        if n > 0 && n % 100 == 0 {
            let s1 = commit(&mut stream, &format!("refs/heads/side{n}"), "side a", &[head], t + 10);
            let s2 = commit(&mut stream, &format!("refs/heads/side{n}"), "side b", &[s1], t + 20);
            head = commit(&mut stream, "refs/heads/main", "merge side", &[head, s2], t + 30);
        } else {
            let parents: Vec<usize> = if head == 0 { vec![] } else { vec![head] };
            head = commit(&mut stream, "refs/heads/main", &format!("c{n}"), &parents, t);
        }
    }
    let mut child = Command::new("git").args(["fast-import", "--quiet"]).current_dir(&repo).stdin(std::process::Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
    assert!(child.wait().unwrap().success());
    (TempDir(base), repo)
}

#[test]
fn history_read_in_git_chunks_matches_one_read() {
    let (_tmp, repo) = long_history("chunks");
    let id = repo.to_string_lossy().to_string();
    let tip = sh(&repo, &["rev-parse", "main"]);
    let fresh = || {
        let s = State::with_config(repo.parent().unwrap().join(format!("config-{}.json", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        dispatch(&s, "addPath", json!({ "path": repo })).unwrap();
        s
    };
    let a = fresh();
    let one = dispatch(&a, "history", json!({ "id": id, "trunkTip": tip, "tip": tip, "offset": 0, "count": 3000 })).unwrap();
    let b = fresh();
    let p1 = dispatch(&b, "history", json!({ "id": id, "trunkTip": tip, "tip": tip, "offset": 0, "count": 1200 })).unwrap();
    let p2 = dispatch(&b, "history", json!({ "id": id, "trunkTip": tip, "tip": tip, "offset": 1200, "count": 2000 })).unwrap();
    let mut rows = p1["rows"].as_array().unwrap().clone();
    rows.extend(p2["rows"].as_array().unwrap().iter().cloned());
    assert_eq!(one["rows"].as_array().unwrap().len(), 2500 + 24 * 2);
    assert_eq!(&rows, one["rows"].as_array().unwrap());
    assert_eq!(p1["hasMore"], json!(true));
    assert_eq!(p2["hasMore"], json!(false));
    // The trunk's first-parent chain stays in column 0 across the chunk boundary.
    let chain: Vec<String> = sh(&repo, &["rev-list", "--first-parent", "main"]).lines().map(str::to_string).collect();
    assert!(rows.iter().filter(|r| chain.contains(&r["id"].as_str().unwrap().to_string())).all(|r| r["col"] == 0));
}

#[test]
fn uncommitted_row_behind_the_trunk_gets_its_own_lane() {
    let f = fixture("behind");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    // The squash worktree sits on an older trunk commit? Make a worktree exactly on main~1 and dirty it.
    let old = sh(&f.main, &["rev-parse", "main~1"]);
    let wt = f.main.parent().unwrap().join("wt-behind");
    sh(&f.main, &["worktree", "add", "-q", "--detach", wt.to_str().unwrap(), &old]);
    write(&wt, "README.md", "changed\n");
    let trunk = sh(&f.main, &["rev-parse", "main"]);
    let page = call(&f, "history", json!({ "id": id, "trunkTip": trunk, "tip": old, "worktreeHead": old }));
    let rows = page["rows"].as_array().unwrap();
    let wt_row = rows.iter().find(|r| r["id"] == "WORKTREE").unwrap();
    assert_ne!(wt_row["col"], 0, "a trunk line already runs through column 0 here");
    let base = rows.iter().find(|r| r["id"] == json!(old)).unwrap();
    assert_eq!(base["col"], 0, "the trunk commit itself stays in column 0");
}

#[test]
fn files_follow_the_selected_version() {
    let f = fixture("files");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let paths = |v: Value| v["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect::<Vec<_>>();

    // A commit: its whole tree, not just what it changed.
    let root = sh(&f.main, &["rev-list", "--max-parents=0", "main"]);
    assert_eq!(paths(call(&f, "files", json!({ "id": id, "target": { "kind": "commit", "hash": root } }))), vec!["README.md"]);
    let at_main = paths(call(&f, "files", json!({ "id": id, "target": { "kind": "commit", "hash": sh(&f.main, &["rev-parse", "main"]) } })));
    assert_eq!(at_main, vec!["README.md", "src/lib.rs", "src/merged.rs", "src/squash.rs"]);

    // On disk: tracked + untracked, without ignored or deleted files.
    write(&f.wt_open, ".gitignore", "build/\n");
    write(&f.wt_open, "build/out.js", "x\n");
    std::fs::remove_file(f.wt_open.join("README.md")).unwrap();
    let tree = f.wt_open.to_string_lossy().to_string();
    let on_disk = paths(call(&f, "files", json!({ "id": id, "target": { "kind": "worktree", "tree": tree } })));
    assert_eq!(on_disk, vec![".gitignore", "notes/todo.md", "src/lib.rs", "src/merged.rs", "src/open.rs", "src/squash.rs", "src/staged.rs"]);

    // A branch compared with the trunk: the files committed at its tip, not what's on disk.
    let tip = paths(call(&f, "files", json!({ "id": id, "target": { "kind": "compare", "base": "main", "tip": "feat/open" } })));
    assert!(tip.contains(&"src/open.rs".to_string()) && tip.contains(&"README.md".to_string()));
    assert!(!tip.contains(&"notes/todo.md".to_string()) && !tip.contains(&"src/staged.rs".to_string()));
}

#[test]
fn file_content_reads_text_images_and_both_sides() {
    let f = fixture("content");
    call(&f, "addPath", json!({ "path": f.main }));
    let id = f.main.to_string_lossy().to_string();
    let tree = f.wt_open.to_string_lossy().to_string();
    let wt = json!({ "kind": "worktree", "tree": tree });

    // Text on disk, and the same file at HEAD (the "old" side of uncommitted work).
    let new = call(&f, "fileContent", json!({ "id": id, "target": wt, "path": "src/lib.rs", "side": "new" }));
    assert_eq!(new["text"], "pub fn a() {}\npub fn b() {}\n");
    let old = call(&f, "fileContent", json!({ "id": id, "target": wt, "path": "src/lib.rs", "side": "old" }));
    assert_eq!(old["text"], "pub fn a() {}\n");
    // Untracked: nothing on the old side.
    assert!(call(&f, "fileContent", json!({ "id": id, "target": wt, "path": "notes/todo.md", "side": "old" })).is_null());

    // An image in a commit comes as base64 with its type; its parent didn't have it.
    std::fs::write(f.main.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
    sh(&f.main, &["add", "logo.png"]);
    sh(&f.main, &["commit", "-q", "-m", "logo"]);
    let head = json!({ "kind": "commit", "hash": sh(&f.main, &["rev-parse", "HEAD"]) });
    let png = call(&f, "fileContent", json!({ "id": id, "target": head, "path": "logo.png", "side": "new" }));
    assert_eq!((png["mime"].as_str(), png["data"].as_str(), png["binary"].as_bool()), (Some("image/png"), Some("iVBORwAB"), Some(true)));
    assert!(call(&f, "fileContent", json!({ "id": id, "target": head, "path": "logo.png", "side": "old" })).is_null());

    // Same guards as file pairs.
    assert!(dispatch(&f.state, "fileContent", json!({ "id": id, "target": wt, "path": "../outside", "side": "new" })).is_err());
    assert!(dispatch(&f.state, "fileContent", json!({ "id": id, "target": wt, "path": "x", "side": "old", "oldPath": "/etc/passwd" })).is_err());
}
