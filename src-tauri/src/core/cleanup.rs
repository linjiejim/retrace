//! Remove worktrees and local branches whose work is already in the trunk. The one write path
//! besides `fetch`.
//!
//! Rules (from the foldgit fork's worktree cleanup spec): only linked, unlocked, clean trees whose
//! HEAD is in the trunk (ancestor or squash); never `--force`; every tree and branch is re-verified
//! right before it is removed; ignored files that can't be regenerated (`.env`…) and recent activity
//! are reported so the UI leaves those unticked. A branch is deleted only while it still points at
//! the commit that was checked (`update-ref -d <ref> <old>`), which also covers squash merges that
//! `git branch -d` refuses; long-lived and kept branches are never deleted.

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
const PROTECTED: [&str; 6] = ["develop", "development", "dev", "staging", "production", "gh-pages"];
const PROTECTED_PREFIXES: [&str; 3] = ["release/", "releases/", "release-"];

pub fn is_protected(name: &str) -> bool {
    PROTECTED.contains(&name) || PROTECTED_PREFIXES.iter().any(|p| name.starts_with(p))
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
}

/// The checks shared by listing and removing. `strict` re-counts untracked files one by one.
fn eligible(dir: &Path, tree: &Worktree, trunk: &Trunk, cache: &IntegrationCache, strict: bool) -> Result<Verdict> {
    let path = Path::new(&tree.path);
    if tree.is_main || tree.bare {
        bail!(tr!("主 worktree 不能删除", "The main worktree can't be removed"));
    }
    if tree.locked {
        bail!(tr!("worktree 已锁定", "The worktree is locked"));
    }
    if tree.prunable || !path.is_dir() {
        bail!(tr!("worktree 目录已经不存在", "The worktree folder no longer exists"));
    }
    if tree.branch.as_deref() == Some(trunk.name.as_str()) {
        bail!(tr!("检出的是集成分支", "It has the integration branch checked out"));
    }
    let head = tree.head.as_deref().ok_or_else(|| anyhow::anyhow!(tr!("还没有提交", "No commits yet")))?;
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
    let cmp = repo::compare_with_trunk(dir, trunk, head, cache)?;
    if cmp.integration == Integration::None {
        bail!(tr!("还没有合并到 {}", "Not merged into {} yet", trunk.name));
    }
    Ok(Verdict { integration: cmp.integration })
}

pub fn candidates(dir: &Path, trunk: &Trunk, trees: &[Worktree], cache: &IntegrationCache) -> Vec<CleanupCandidate> {
    std::thread::scope(|s| {
        let handles: Vec<_> = trees
            .iter()
            .filter(|t| !t.is_main && !t.bare)
            .map(|t| {
                s.spawn(move || {
                    let verdict = eligible(dir, t, trunk, cache, false).ok()?;
                    let notable = notable_ignored(Path::new(&t.path));
                    let head = t.head.clone()?;
                    Some(CleanupCandidate {
                        path: t.path.clone(),
                        branch: t.branch.clone(),
                        last_commit_at: last_commit_time(dir, &head),
                        head,
                        integration: verdict.integration,
                        notable_ignored: notable,
                        recent: recently_active(Path::new(&t.path)),
                    })
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    })
}

/// Re-verify, then `git worktree remove` (never `--force`) and optionally delete its branch.
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
    kept: &[String],
    cache: &IntegrationCache,
) -> Result<RemoveOutcome> {
    let trees = repo::worktrees(dir)?;
    let tree = trees.iter().find(|t| t.path == tree_path).ok_or_else(|| anyhow::anyhow!(tr!("不是这个项目的 worktree", "Not a worktree of this project")))?;
    if tree.head.as_deref() != Some(expect_head) {
        bail!(tr!("HEAD 在确认之后变了，已跳过", "HEAD moved after you confirmed; skipped"));
    }
    let path = Path::new(tree_path);
    eligible(dir, tree, trunk, cache, true)?;
    let unseen: Vec<String> = notable_ignored(path).into_iter().filter(|n| !acknowledged_ignored.contains(n)).collect();
    if !unseen.is_empty() {
        bail!(tr!("确认之后出现了被忽略的 {}，已跳过；重新打开列表确认后再删", "Ignored {} appeared after you confirmed; skipped. Reopen the list and confirm again", unseen.join(", ")));
    }
    // The scans above can take a while: a commit made meanwhile was never checked against the trunk.
    let live = git::text(path, &["rev-parse", "HEAD"])?;
    if live.trim() != expect_head {
        bail!(tr!("HEAD 在检查期间变了，已跳过", "HEAD moved during the check; skipped"));
    }
    git::run(dir, &["worktree", "remove", tree_path])?;

    let mut outcome = RemoveOutcome { branch_deleted: false, branch_kept_reason: None };
    if let (true, Some(branch)) = (delete_branch, tree.branch.as_deref()) {
        let kept_reason = if is_protected(branch) || kept.iter().any(|k| k == branch) {
            Some(tr!("这是保留的分支，没有删除", "Kept: it's a branch you keep"))
        } else if repo::worktrees(dir)?.iter().any(|t| t.branch.as_deref() == Some(branch)) {
            Some(tr!("另一个 worktree 也检出了这个分支，已保留", "Kept: another worktree has it checked out"))
        } else {
            // HEAD was `expect_head` a moment ago, so that is where its branch points.
            delete_ref_if_at(dir, branch, expect_head).err().map(|e| format!("{e:#}"))
        };
        match kept_reason {
            None => outcome.branch_deleted = true,
            Some(reason) => outcome.branch_kept_reason = Some(reason),
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

/// Local branches no worktree has checked out (the trunk aside), each judged against the trunk.
pub fn branch_statuses(dir: &Path, trunk: &Trunk, refs: &[repo::RefEntry], trees: &[Worktree], kept: &[String], cache: &IntegrationCache) -> Vec<BranchStatus> {
    let checked_out: HashSet<&str> = trees.iter().filter_map(|t| t.branch.as_deref()).collect();
    let existing: HashSet<&str> = refs.iter().map(|e| e.full.as_str()).collect();
    let locals: Vec<(&repo::RefEntry, &str, bool)> = refs
        .iter()
        .filter(|e| e.symref.is_none())
        .filter_map(|e| Some((e, e.full.strip_prefix("refs/heads/")?)))
        .filter(|(_, name)| *name != trunk.name && !checked_out.contains(name))
        .map(|(e, name)| (e, name, e.upstream.as_deref().is_some_and(|u| !existing.contains(u))))
        .collect();
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
                        Some(BranchStatus {
                            name: name.to_string(),
                            tip: e.target.clone(),
                            ahead: cmp.ahead,
                            integration: cmp.integration,
                            last_commit_at: e.committed_at,
                            upstream_gone,
                            never_committed: only_created && cmp.integration == Integration::Ancestor,
                            recent: moved_at.or(e.committed_at).is_some_and(|t| now - t < RECENT.as_secs() as i64),
                            protected: is_protected(name),
                            kept: kept.iter().any(|k| k == name),
                        })
                    })
                })
                .collect();
            out.extend(handles.into_iter().filter_map(|h| h.join().ok().flatten()));
        });
    }
    out
}

/// Remove `refs/heads/<name>` only while it still points at `tip`, in one step, then its
/// `branch.<name>.*` settings, as `git branch -d` does.
fn delete_ref_if_at(dir: &Path, name: &str, tip: &str) -> Result<()> {
    git::run(dir, &["update-ref", "-d", &format!("refs/heads/{name}"), tip])?;
    let _ = git::run(dir, &["config", "--remove-section", &format!("branch.{name}")]);
    Ok(())
}

/// Delete a local branch already in the trunk, after checking everything again.
pub fn delete_branch(dir: &Path, trunk: &Trunk, name: &str, expect_tip: &str, kept: &[String], cache: &IntegrationCache) -> Result<()> {
    let full = format!("refs/heads/{name}");
    let refs = repo::refs(dir)?;
    let entry = refs
        .iter()
        .find(|e| e.full == full && e.symref.is_none())
        .ok_or_else(|| anyhow!(tr!("分支已经不存在", "The branch no longer exists")))?;
    if entry.target != expect_tip {
        bail!(tr!("分支在确认之后变了，已跳过", "The branch moved after you confirmed; skipped"));
    }
    if name == trunk.name {
        bail!(tr!("这是集成分支", "It's the integration branch"));
    }
    if is_protected(name) || kept.iter().any(|k| k == name) {
        bail!(tr!("这是保留的分支", "It's a branch you keep"));
    }
    if repo::worktrees(dir)?.iter().any(|t| t.branch.as_deref() == Some(name)) {
        bail!(tr!("有 worktree 检出了这个分支", "A worktree has it checked out"));
    }
    if repo::compare_with_trunk(dir, trunk, expect_tip, cache)?.integration == Integration::None {
        bail!(tr!("还没有合并到 {}", "Not merged into {} yet", trunk.name));
    }
    delete_ref_if_at(dir, name, expect_tip)
}

/// Undo for `delete_branch`: the branch comes back at `tip`, only if the name is still free.
pub fn restore_branch(dir: &Path, name: &str, tip: &str) -> Result<()> {
    git::run(dir, &["update-ref", &format!("refs/heads/{name}"), tip, ""])?;
    Ok(())
}
