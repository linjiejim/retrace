//! Remove worktrees and local branches whose work is already in the trunk. The one write path
//! besides `fetch`.
//!
//! Rules (from the foldgit fork's worktree cleanup spec): only linked, unlocked, clean trees whose
//! HEAD is in the trunk (ancestor or squash); never `--force`; every tree and branch is re-verified
//! right before it is removed; ignored files that can't be regenerated (`.env`…) and recent activity
//! are reported so the UI leaves those unticked. A branch is deleted only while it still points at
//! the commit that was checked (`update-ref -d <ref> <old>`), which also covers squash merges that
//! `git branch -d` refuses; long-lived and kept branches are never deleted.
//!
//! A tree whose folder was deleted from under git counts by the HEAD git recorded for it; removing
//! it drops only that record.
//!
//! When asked, a deleted branch's copy on origin goes too (`git push origin :<branch>`, the one
//! push): only its own copy, only while origin still has it where the last fetch saw it, and only
//! if that commit is in the trunk as well.

use crate::tr;
use super::model::*;
use super::repo::{self, IntegrationCache};
use super::git;
use anyhow::{anyhow, bail, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Folders and files that a build or install brings back.
const REGENERABLE: [&str; 12] =
    ["node_modules", ".build", "DerivedData", "dist", "build", ".next", ".turbo", ".venv", "__pycache__", "target", ".gradle", ".DS_Store"];
/// A tree touched this recently may belong to an agent that just started.
const RECENT: Duration = Duration::from_secs(15 * 60);
/// Branches that stay around after being merged, by design.
const PROTECTED: [&str; 8] = ["main", "master", "develop", "development", "dev", "staging", "production", "gh-pages"];
const PROTECTED_PREFIXES: [&str; 3] = ["release/", "releases/", "release-"];
/// The remote whose copies of deleted branches may be deleted too.
const ORIGIN: &str = "origin";
const PUSH_TIMEOUT: Duration = Duration::from_secs(60);

pub fn is_protected(name: &str) -> bool {
    PROTECTED.contains(&name) || PROTECTED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// The trunk's own local branch, however the trunk is named (`main`, `origin/main`, `upstream/main`).
/// Not "tracks the trunk's remote branch": `git switch -c x origin/main` sets that upstream on
/// every feature branch.
fn is_trunk_branch(trunk: &Trunk, name: &str) -> bool {
    let after_remote = |r: &str| r.split_once('/').is_some_and(|(_, b)| b == name);
    [trunk.name.as_str(), trunk.tip_ref.as_str()].into_iter().chain(trunk.remote_ref.as_deref()).any(|r| r == name || after_remote(r))
}

/// Branches git itself counts as in use, so `git branch -d` would refuse them: checked out in a
/// worktree, or being rebased or bisected there (the worktree shows a detached HEAD meanwhile).
fn branches_in_use(trees: &[Worktree]) -> HashSet<String> {
    let mut used: HashSet<String> = trees.iter().filter_map(|t| t.branch.clone()).collect();
    for tree in trees.iter().filter(|t| !t.bare) {
        let Some(gd) = git_dir_of(Path::new(&tree.path)) else { continue };
        for file in ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START", "rebase-merge/update-refs"] {
            let Ok(text) = std::fs::read_to_string(gd.join(file)) else { continue };
            for line in text.lines().map(str::trim) {
                if let Some(name) = line.strip_prefix("refs/heads/") {
                    used.insert(name.to_string());
                } else if file == "BISECT_START" && !line.is_empty() {
                    used.insert(line.to_string());
                }
            }
        }
    }
    used
}

fn git_dir_of(tree: &Path) -> Option<PathBuf> {
    let dot = tree.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let content = std::fs::read_to_string(&dot).ok()?;
    let path = PathBuf::from(content.trim().strip_prefix("gitdir:")?.trim());
    Some(if path.is_absolute() { path } else { tree.join(path) })
}

fn recently_active(tree: &Path) -> bool {
    let Some(dir) = git_dir_of(tree) else { return false };
    let now = SystemTime::now();
    ["HEAD", "index", "logs/HEAD"].iter().any(|f| {
        std::fs::metadata(dir.join(f))
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).unwrap_or_default() < RECENT)
    })
}

/// Ignored paths in the tree (`git worktree remove` deletes them silently), as git reports them:
/// a whole ignored folder is one entry.
fn ignored_entries(tree: &Path) -> Vec<String> {
    let Ok(out) = git::run_heavy(tree, &["status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=normal"]) else {
        return vec![];
    };
    let mut paths: Vec<String> = git::nul_tokens(&out)
        .into_iter()
        .filter_map(|t| t.strip_prefix("!! ").map(|p| p.trim_end_matches('/').to_string()))
        .filter(|p| !p.is_empty())
        .collect();
    paths.sort();
    paths
}

/// Ignored entries a build won't bring back, judged by the entry's own name: `apps/web/node_modules`
/// is regenerable, `apps/api/.env.local` is not.
fn notable_ignored(tree: &Path) -> Vec<String> {
    ignored_entries(tree)
        .into_iter()
        .filter(|p| !REGENERABLE.contains(&p.rsplit('/').next().unwrap_or(p.as_str())))
        .collect()
}

fn last_commit_time(dir: &Path, head: &str) -> Option<i64> {
    git::text(dir, &["log", "-1", "--format=%ct", head, "--"]).ok()?.trim().parse().ok()
}

struct Verdict {
    integration: Integration,
    /// The folder is already gone (git lists the tree as prunable): only git's record is left.
    gone: bool,
}

/// The checks shared by listing and removing. `strict` re-counts untracked files one by one.
/// A tree whose folder was deleted from under git qualifies too, by the HEAD git recorded for it:
/// nothing uncommitted is left to lose, and `git worktree remove` then drops just that record.
/// A folder that's still there but no longer a worktree (its `.git` gone) never qualifies: git
/// refuses to remove it, and it may hold files of its own.
fn eligible(dir: &Path, tree: &Worktree, trunk: &Trunk, cache: &IntegrationCache, strict: bool) -> Result<Verdict> {
    let path = Path::new(&tree.path);
    if tree.is_main || tree.bare {
        bail!(tr!("主 worktree 不能删除", "The main worktree can't be removed"));
    }
    if tree.locked {
        bail!(tr!("worktree 已锁定", "The worktree is locked"));
    }
    let gone = tree.prunable && !path.exists();
    if !gone && (tree.prunable || !path.is_dir()) {
        bail!(tr!("目录还在，但已经不是 worktree", "The folder is there but no longer a worktree"));
    }
    if tree.branch.as_deref().is_some_and(|b| is_trunk_branch(trunk, b)) {
        bail!(tr!("检出的是集成分支", "It has the integration branch checked out"));
    }
    let head = tree.head.as_deref().ok_or_else(|| anyhow::anyhow!(tr!("还没有提交", "No commits yet")))?;
    if !gone {
        let counts = if strict {
            repo::parse_status(&git::run_heavy(path, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?)
        } else {
            repo::worktree_counts(path)?
        };
        if counts.files > 0 {
            bail!(tr!("有 {} 个文件未提交", "{} files are uncommitted", counts.files));
        }
        if let Some(op) = repo::operation(path) {
            bail!(tr!("有进行中的 {op}", "A {op} is in progress"));
        }
    }
    let cmp = repo::compare_with_trunk(dir, trunk, head, cache)?;
    if cmp.integration == Integration::None {
        bail!(tr!("还没有合并到 {}", "Not merged into {} yet", trunk.name));
    }
    Ok(Verdict { integration: cmp.integration, gone })
}

pub fn candidates(dir: &Path, trunk: &Trunk, trees: &[Worktree], cache: &IntegrationCache) -> Vec<CleanupCandidate> {
    let refs = repo::refs(dir).unwrap_or_default();
    let refs = &refs;
    std::thread::scope(|s| {
        let handles: Vec<_> = trees
            .iter()
            .filter(|t| !t.is_main && !t.bare)
            .map(|t| {
                s.spawn(move || {
                    let verdict = eligible(dir, t, trunk, cache, false).ok()?;
                    let notable = if verdict.gone { vec![] } else { notable_ignored(Path::new(&t.path)) };
                    let head = t.head.clone()?;
                    Some(CleanupCandidate {
                        path: t.path.clone(),
                        branch: t.branch.clone(),
                        last_commit_at: last_commit_time(dir, &head),
                        on_origin: t.branch.as_deref().is_some_and(|b| origin_copy(refs, b, &head).is_some()),
                        head,
                        integration: verdict.integration,
                        notable_ignored: notable,
                        recent: !verdict.gone && recently_active(Path::new(&t.path)),
                        missing: verdict.gone,
                    })
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    })
}

// ---------- the copy on origin ----------

/// The tip of the branch's own copy on origin, as of the last fetch: `origin/<name>`, when the
/// branch tracks it or points at the same commit. A same-named branch someone else pushed, which
/// this branch neither tracks nor matches, is not its copy.
pub fn origin_copy(refs: &[repo::RefEntry], name: &str, local_tip: &str) -> Option<String> {
    let remote_full = format!("refs/remotes/{ORIGIN}/{name}");
    let copy = refs.iter().find(|e| e.full == remote_full && e.symref.is_none())?;
    let local_full = format!("refs/heads/{name}");
    let tracks = refs.iter().any(|e| e.full == local_full && e.upstream.as_deref() == Some(remote_full.as_str()));
    (tracks || copy.target == local_tip).then(|| copy.target.clone())
}

/// Delete the branch's copy on origin, after its local branch is gone. Only while origin still has
/// it at `copy_tip` (`--force-with-lease`), and only if that commit is in the trunk too. A problem
/// keeps the copy, with the reason (shown after "kept on origin:"); it never undoes the local
/// deletion. Pre-push hooks are skipped:
/// a deletion carries no code to check.
fn delete_on_origin(dir: &Path, trunk: &Trunk, name: &str, local_tip: &str, copy_tip: &str, cache: &IntegrationCache) -> RemoteDeletion {
    let label = format!("{ORIGIN}/{name}");
    let kept = |reason: String| RemoteDeletion { deleted: None, kept_reason: Some(reason) };
    if is_trunk_branch(trunk, name) || is_protected(name) {
        return kept(tr!("这是长期分支", "It's a long-lived branch"));
    }
    // The local tip was just checked against the trunk; a different commit on origin wasn't.
    if copy_tip != local_tip {
        match repo::compare_with_trunk(dir, trunk, copy_tip, cache) {
            Ok(cmp) if cmp.integration != Integration::None => {}
            Ok(_) => return kept(tr!("{label} 上有 {} 没有的提交", "{label} has commits {} doesn't", trunk.name)),
            Err(e) => return kept(format!("{e:#}")),
        }
    }
    let lease = format!("--force-with-lease=refs/heads/{name}:{copy_tip}");
    let refspec = format!(":refs/heads/{name}");
    match git::run_with_timeout_output(dir, &["push", "--porcelain", "--no-verify", &lease, ORIGIN, &refspec], PUSH_TIMEOUT) {
        Ok(out) if out.ok => RemoteDeletion { deleted: Some(label), kept_reason: None },
        Ok(out) => kept(push_refused(&out, &label)),
        Err(e) => kept(format!("{e:#}")),
    }
}

/// Why a push was refused: its porcelain line (`!\t<refspec>\t[rejected] (stale info)`), else
/// git's last error (no access, no network).
fn push_refused(out: &git::Finished, label: &str) -> String {
    let refused = out.stdout.lines().find_map(|l| l.strip_prefix("!\t")).and_then(|l| l.split('\t').nth(1)).map(str::trim);
    match refused {
        Some(r) if r.contains("stale info") => {
            tr!("{label} 在上次 fetch 之后变了或已被删掉", "{label} moved or was deleted since the last fetch")
        }
        Some(r) => tr!("origin 拒绝删除 {label}：{r}", "origin refused to delete {label}: {r}"),
        None => tr!("没能删除 {label}：{}", "Couldn't delete {label}: {}", git::last_error_line(&out.stderr)),
    }
}

/// Re-verify, then `git worktree remove` (never `--force`) and optionally delete its branch, and
/// with it (`delete_remote`) the branch's copy on origin.
/// `acknowledged_ignored`: the irreplaceable ignored files the user saw when confirming; any new one
/// stops the removal, since `git worktree remove` deletes ignored files without asking.
#[allow(clippy::too_many_arguments)]
pub fn remove(
    dir: &Path,
    trunk: &Trunk,
    tree_path: &str,
    expect_head: &str,
    acknowledged_ignored: &[String],
    delete_branch: bool,
    delete_remote: bool,
    kept: &[String],
    cache: &IntegrationCache,
) -> Result<RemoveOutcome> {
    let trees = repo::worktrees(dir)?;
    let tree = trees.iter().find(|t| t.path == tree_path).ok_or_else(|| anyhow::anyhow!(tr!("不是这个项目的 worktree", "Not a worktree of this project")))?;
    if tree.head.as_deref() != Some(expect_head) {
        bail!(tr!("HEAD 在确认之后变了，已跳过", "HEAD moved after you confirmed; skipped"));
    }
    let path = Path::new(tree_path);
    let verdict = eligible(dir, tree, trunk, cache, true)?;
    // A gone folder has no files to scan and no HEAD to move: git's record is all that's left.
    if !verdict.gone {
        let unseen: Vec<String> = notable_ignored(path).into_iter().filter(|n| !acknowledged_ignored.contains(n)).collect();
        if !unseen.is_empty() {
            bail!(tr!("确认之后出现了被忽略的 {}，已跳过；重新打开列表确认后再删", "Ignored {} appeared after you confirmed; skipped. Reopen the list and confirm again", unseen.join(", ")));
        }
        // The scans above can take a while: a commit made meanwhile was never checked against the trunk.
        let live = git::text(path, &["rev-parse", "HEAD"])?;
        if live.trim() != expect_head {
            bail!(tr!("HEAD 在检查期间变了，已跳过", "HEAD moved during the check; skipped"));
        }
    }
    // For a gone folder this drops only its record (unlike `git worktree prune`, which drops every
    // stale one, including trees whose detached HEAD nothing else keeps).
    git::run(dir, &["worktree", "remove", tree_path])?;

    let mut outcome = RemoveOutcome { branch_deleted: false, deleted_branch: None, branch_kept_reason: None, deleted: None, remote: RemoteDeletion::default() };
    if let (true, Some(branch)) = (delete_branch, tree.branch.as_deref()) {
        // The tree is already gone: from here on a failure keeps the branch, it doesn't fail the removal.
        // Its copy on origin is read while the branch (and so what it tracks) still exists.
        let copy = if delete_remote { repo::refs(dir).ok().and_then(|refs| origin_copy(&refs, branch, expect_head)) } else { None };
        let in_use = repo::worktrees(dir).map(|t| branches_in_use(&t).contains(branch));
        let result = if is_trunk_branch(trunk, branch) {
            Err(tr!("这是集成分支，没有删除", "Kept: it's the integration branch"))
        } else if is_protected(branch) {
            Err(tr!("长期分支，没有删除", "Kept: it's a long-lived branch"))
        } else if kept.iter().any(|k| k == branch) {
            Err(tr!("你设为保留的分支，没有删除", "Kept: it's a branch you keep"))
        } else if !matches!(in_use, Ok(false)) {
            Err(tr!("另一个 worktree 还在用这个分支，已保留", "Kept: another worktree is using it"))
        } else {
            // HEAD was `expect_head` a moment ago, so that is where its branch points.
            delete_ref_if_at(dir, branch, expect_head).map_err(|e| format!("{e:#}"))
        };
        match result {
            Ok(deleted) => {
                if let Some(copy_tip) = copy {
                    outcome.remote = delete_on_origin(dir, trunk, branch, expect_head, &copy_tip, cache);
                }
                outcome.branch_deleted = true;
                outcome.deleted_branch = Some(deleted.name.clone());
                outcome.deleted = Some(deleted);
            }
            Err(reason) => outcome.branch_kept_reason = Some(reason),
        }
    }
    Ok(outcome)
}

// ---------- branches without a worktree ----------

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// From the branch's reflog: when it last moved, and whether being created is all that happened.
/// Read from the file (`<common dir>/logs/refs/heads/<name>`): this runs for every branch whenever
/// refs change. Without a reflog file (reftable, logging off) both answers are unknown.
fn branch_reflog(common_dir: Option<&Path>, name: &str) -> (Option<i64>, bool) {
    let Some(Ok(text)) = common_dir.map(|d| std::fs::read_to_string(d.join("logs/refs/heads").join(name))) else { return (None, false) };
    let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
    // `<old> <new> <name> <email> <time> <zone>\t<message>`
    let time = |line: &str| line.split_once('\t').map_or(line, |(head, _)| head).split_whitespace().rev().nth(1).and_then(|t| t.parse().ok());
    let only_created = lines.len() == 1 && lines[0].split_once('\t').is_some_and(|(_, msg)| msg.starts_with("branch: Created from"));
    (lines.last().and_then(|l| time(l)), only_created)
}

/// Local branches no worktree is using (the trunk's own aside), each judged against the trunk.
pub fn branch_statuses(dir: &Path, trunk: &Trunk, refs: &[repo::RefEntry], trees: &[Worktree], kept: &[String], cache: &IntegrationCache) -> Vec<BranchStatus> {
    let in_use = branches_in_use(trees);
    let existing: HashSet<&str> = refs.iter().map(|e| e.full.as_str()).collect();
    let locals: Vec<(&repo::RefEntry, &str, bool)> = refs
        .iter()
        .filter(|e| e.symref.is_none())
        .filter_map(|e| Some((e, e.full.strip_prefix("refs/heads/")?)))
        .filter(|(_, name)| !is_trunk_branch(trunk, name) && !in_use.contains(*name))
        .map(|(e, name)| (e, name, e.upstream.as_deref().is_some_and(|u| !existing.contains(u))))
        .collect();
    let committed: std::collections::HashMap<String, i64> = git::text(dir, &["for-each-ref", "--format=%(refname)%00%(committerdate:unix)", "refs/heads"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\0').and_then(|(r, t)| Some((r.to_string(), t.parse().ok()?))))
        .collect();
    let committed = &committed;
    let common_dir = git::text(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok().map(|d| PathBuf::from(d.trim()));
    let common_dir = common_dir.as_deref().filter(|d| d.is_absolute());
    let now = unix_now();
    let mut out = Vec::with_capacity(locals.len());
    for chunk in locals.chunks(8) {
        std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|&(e, name, upstream_gone)| {
                    s.spawn(move || {
                        let cmp = repo::compare_with_trunk(dir, trunk, &e.target, cache).ok()?;
                        let (moved_at, only_created) = branch_reflog(common_dir, name);
                        let last_commit_at = committed.get(&e.full).copied();
                        Some(BranchStatus {
                            name: name.to_string(),
                            tip: e.target.clone(),
                            ahead: cmp.ahead,
                            integration: cmp.integration,
                            last_commit_at,
                            upstream_gone,
                            never_committed: only_created && cmp.integration == Integration::Ancestor,
                            recent: moved_at.or(last_commit_at).is_some_and(|t| now - t < RECENT.as_secs() as i64),
                            protected: is_protected(name),
                            kept: kept.iter().any(|k| k == name),
                            on_origin: origin_copy(refs, name, &e.target).is_some(),
                        })
                    })
                })
                .collect();
            out.extend(handles.into_iter().filter_map(|h| h.join().ok().flatten()));
        });
    }
    out
}

/// `branch.<name>.*` settings, exactly this branch's (not `branch.<name>.x.*` of a longer name).
/// A key written without a value (`[branch "x"] flag`, meaning true) has no value here.
fn branch_config(dir: &Path, name: &str) -> Vec<(String, Option<String>)> {
    let Ok((0, out)) = git::code(dir, &["config", "--local", "--null", "--get-regexp", "^branch\\."]) else { return vec![] };
    let prefix = format!("branch.{name}.");
    git::nul_tokens(&out)
        .into_iter()
        .filter_map(|entry| {
            let (key, value) = match entry.split_once('\n') {
                Some((k, v)) => (k.to_string(), Some(v.to_string())),
                None => (entry.clone(), None),
            };
            let var = key.strip_prefix(&prefix)?;
            (!var.contains('.')).then_some((key, value))
        })
        .collect()
}

/// Remove `refs/heads/<name>` only while it still points at `tip`, in one step, then its
/// `branch.<name>.*` settings, as `git branch -d` does. Returns what Undo needs.
fn delete_ref_if_at(dir: &Path, name: &str, tip: &str) -> Result<DeletedBranch> {
    let config = branch_config(dir, name);
    git::run(dir, &["update-ref", "-d", &format!("refs/heads/{name}"), tip])?;
    if !config.is_empty() {
        let _ = git::run(dir, &["config", "--local", "--remove-section", &format!("branch.{name}")]);
    }
    Ok(DeletedBranch { name: name.to_string(), tip: tip.to_string(), config })
}

/// Delete a local branch already in the trunk, after checking everything again. Whether something
/// uses the branch is checked last, right before the compare-and-delete. Then, with
/// `delete_remote`, its copy on origin.
pub fn delete_branch(
    dir: &Path,
    trunk: &Trunk,
    name: &str,
    expect_tip: &str,
    delete_remote: bool,
    kept: &[String],
    cache: &IntegrationCache,
) -> Result<(DeletedBranch, RemoteDeletion)> {
    let full = format!("refs/heads/{name}");
    let refs = repo::refs(dir)?;
    let entry = refs
        .iter()
        .find(|e| e.full == full && e.symref.is_none())
        .ok_or_else(|| anyhow!(tr!("分支已经不存在", "The branch no longer exists")))?;
    if entry.target != expect_tip {
        bail!(tr!("分支在确认之后变了，已跳过", "The branch moved after you confirmed; skipped"));
    }
    if is_trunk_branch(trunk, name) {
        bail!(tr!("这是集成分支", "It's the integration branch"));
    }
    if is_protected(name) {
        bail!(tr!("这是长期分支", "It's a long-lived branch"));
    }
    if kept.iter().any(|k| k == name) {
        bail!(tr!("这是你设为保留的分支", "It's a branch you keep"));
    }
    if repo::compare_with_trunk(dir, trunk, expect_tip, cache)?.integration == Integration::None {
        bail!(tr!("还没有合并到 {}", "Not merged into {} yet", trunk.name));
    }
    if branches_in_use(&repo::worktrees(dir)?).contains(name) {
        bail!(tr!("有 worktree 在用这个分支（检出、rebase 或 bisect 中）", "A worktree is using it (checked out, rebasing or bisecting)"));
    }
    let copy = if delete_remote { origin_copy(&refs, name, expect_tip) } else { None };
    let deleted = delete_ref_if_at(dir, name, expect_tip)?;
    let remote = copy.map(|tip| delete_on_origin(dir, trunk, name, expect_tip, &tip, cache)).unwrap_or_default();
    Ok((deleted, remote))
}

/// Undo for a deletion: the branch comes back at its tip, only if the name is still free; then its
/// settings, best effort. Returns the settings that couldn't be written back.
pub fn restore_branch(dir: &Path, deleted: &DeletedBranch) -> Result<Vec<String>> {
    git::run(dir, &["update-ref", &format!("refs/heads/{}", deleted.name), &deleted.tip, ""])?;
    Ok(deleted
        .config
        .iter()
        .filter(|(key, value)| git::run(dir, &["config", "--local", "--add", key, value.as_deref().unwrap_or("true")]).is_err())
        .map(|(key, _)| key.clone())
        .collect())
}
