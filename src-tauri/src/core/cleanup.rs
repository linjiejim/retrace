//! Remove worktrees whose work is already in the trunk. The one write path besides `fetch`.
//!
//! Rules (from the foldgit fork's worktree cleanup spec): only linked, unlocked, clean trees whose
//! HEAD is in the trunk (ancestor or squash); never `--force`; every tree is re-verified right before
//! it is removed; ignored files that can't be regenerated (`.env`…) and recent activity are reported
//! so the UI leaves those unticked; branches are deleted only with `git branch -d`.

use super::model::*;
use super::repo::{self, IntegrationCache};
use super::git;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Folders and files that a build or install brings back.
const REGENERABLE: [&str; 12] =
    ["node_modules", ".build", "DerivedData", "dist", "build", ".next", ".turbo", ".venv", "__pycache__", "target", ".gradle", ".DS_Store"];
/// A tree touched this recently may belong to an agent that just started.
const RECENT: Duration = Duration::from_secs(15 * 60);

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
        bail!("主 worktree 不能删除");
    }
    if tree.locked {
        bail!("worktree 已锁定");
    }
    if tree.prunable || !path.is_dir() {
        bail!("worktree 目录已经不存在");
    }
    if tree.branch.as_deref() == Some(trunk.name.as_str()) {
        bail!("检出的是集成分支");
    }
    let head = tree.head.as_deref().ok_or_else(|| anyhow::anyhow!("还没有提交"))?;
    let counts = if strict {
        repo::parse_status(&git::run_heavy(path, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?)
    } else {
        repo::worktree_counts(path)?
    };
    if counts.files > 0 {
        bail!("有 {} 个文件未提交", counts.files);
    }
    if let Some(op) = repo::operation(path) {
        bail!("有进行中的 {op}");
    }
    let cmp = repo::compare_with_trunk(dir, trunk, head, cache)?;
    if cmp.integration == Integration::None {
        bail!("还没有合并到 {}", trunk.name);
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

/// Re-verify, then `git worktree remove` (never `--force`) and optionally `git branch -d`.
/// `acknowledged_ignored`: the irreplaceable ignored files the user saw when confirming; any new one
/// stops the removal, since `git worktree remove` deletes ignored files without asking.
pub fn remove(
    dir: &Path,
    trunk: &Trunk,
    tree_path: &str,
    expect_head: &str,
    acknowledged_ignored: &[String],
    delete_branch: bool,
    cache: &IntegrationCache,
) -> Result<RemoveOutcome> {
    let trees = repo::worktrees(dir)?;
    let tree = trees.iter().find(|t| t.path == tree_path).ok_or_else(|| anyhow::anyhow!("不是这个项目的 worktree"))?;
    if tree.head.as_deref() != Some(expect_head) {
        bail!("HEAD 在确认之后变了，已跳过");
    }
    let path = Path::new(tree_path);
    let verdict = eligible(dir, tree, trunk, cache, true)?;
    let unseen: Vec<String> = notable_ignored(path).into_iter().filter(|n| !acknowledged_ignored.contains(n)).collect();
    if !unseen.is_empty() {
        bail!("确认之后出现了被忽略的 {}，已跳过；重新打开列表确认后再删", unseen.join("、"));
    }
    // The scans above can take a while: a commit made meanwhile was never checked against the trunk.
    let live = git::text(path, &["rev-parse", "HEAD"])?;
    if live.trim() != expect_head {
        bail!("HEAD 在检查期间变了，已跳过");
    }
    git::run(dir, &["worktree", "remove", tree_path])?;

    let mut outcome = RemoveOutcome { branch_deleted: false, branch_kept_reason: None };
    if let (true, Some(branch)) = (delete_branch, tree.branch.as_deref()) {
        if verdict.integration == Integration::Squash {
            outcome.branch_kept_reason = Some("squash 合并的分支 git branch -d 删不掉，已保留".into());
        } else {
            // `branch -d` judges "merged" against the current branch: run it where the trunk is checked out.
            let at = trees
                .iter()
                .find(|t| t.branch.as_deref() == Some(trunk.name.as_str()) && Path::new(&t.path).is_dir())
                .map(|t| PathBuf::from(&t.path))
                .unwrap_or_else(|| dir.to_path_buf());
            match git::run(&at, &["branch", "-d", "--", branch]) {
                Ok(_) => outcome.branch_deleted = true,
                Err(e) => outcome.branch_kept_reason = Some(format!("{e:#}")),
            }
        }
    }
    Ok(outcome)
}
