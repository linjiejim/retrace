//! Repository shape: where it lives, its worktrees, refs, the integration
//! branch, and per-worktree status. Status logic follows the foldgit fork
//! (docs/specs/20261101-worktree-status-and-cleanup.md there).

use crate::tr;
use super::git;
use super::model::*;
use anyhow::{bail, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ---------- locating repositories ----------

/// The project root for any path inside a repository: the main worktree, or the bare repository.
pub fn project_root(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        bail!(tr!("{} 不是文件夹", "{} is not a folder", path.display()));
    }
    let out = git::text(path, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--is-bare-repository"])?;
    let mut lines = out.lines();
    let common = PathBuf::from(lines.next().unwrap_or_default());
    let bare = lines.next() == Some("true");
    let root = if bare || common.file_name().is_none_or(|n| n != ".git") {
        common
    } else {
        common.parent().map(Path::to_path_buf).unwrap_or(common)
    };
    Ok(std::fs::canonicalize(&root).unwrap_or(root))
}

pub fn looks_like_repo(path: &Path) -> bool {
    path.join(".git").exists() || (path.join("HEAD").is_file() && path.join("objects").is_dir())
}

/// Repositories directly inside `folder` (one level), for the "add a parent folder" flow.
pub fn scan_children(folder: &Path, known: &[String]) -> Vec<Candidate> {
    let Ok(entries) = std::fs::read_dir(folder) else { return vec![] };
    let mut out: Vec<Candidate> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| looks_like_repo(p))
        .filter_map(|p| project_root(&p).ok())
        .map(|root| {
            let path = root.to_string_lossy().into_owned();
            Candidate { name: display_name(&root), added: known.contains(&path), path }
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

pub fn display_name(root: &Path) -> String {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    name.strip_suffix(".git").map(str::to_string).unwrap_or(name)
}

// ---------- worktrees ----------

pub fn worktrees(dir: &Path) -> Result<Vec<Worktree>> {
    let out = git::run(dir, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktrees(&out))
}

pub fn parse_worktrees(bytes: &[u8]) -> Vec<Worktree> {
    let mut trees = Vec::new();
    let mut current: Option<Worktree> = None;
    for token in git::nul_tokens(bytes) {
        if token.is_empty() {
            if let Some(t) = current.take() {
                trees.push(t);
            }
            continue;
        }
        let (key, value) = token.split_once(' ').unwrap_or((token.as_str(), ""));
        match key {
            "worktree" => {
                if let Some(t) = current.take() {
                    trees.push(t);
                }
                current = Some(Worktree {
                    path: value.to_string(),
                    branch: None,
                    head: None,
                    is_main: trees.is_empty(),
                    bare: false,
                    locked: false,
                    prunable: false,
                });
            }
            _ => {
                let Some(t) = current.as_mut() else { continue };
                match key {
                    // An unborn branch (no commits yet) reports an all-zero HEAD.
                    "HEAD" => t.head = Some(value.to_string()).filter(|h| !h.chars().all(|c| c == '0')),
                    "branch" => t.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                    "bare" => t.bare = true,
                    "locked" => t.locked = true,
                    "prunable" => t.prunable = true,
                    _ => {}
                }
            }
        }
    }
    if let Some(t) = current.take() {
        trees.push(t);
    }
    trees
}

// ---------- refs ----------

#[derive(Debug, Clone)]
pub struct RefEntry {
    /// `refs/heads/main`
    pub full: String,
    pub target: String,
    pub upstream: Option<String>,
    pub symref: Option<String>,
}

pub fn refs(dir: &Path) -> Result<Vec<RefEntry>> {
    let out = git::text(
        dir,
        &[
            "for-each-ref",
            "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)%00%(upstream)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 5 {
                return None;
            }
            let target = if f[1].is_empty() { f[0] } else { f[1] };
            Some(RefEntry {
                full: f[2].to_string(),
                target: target.to_string(),
                symref: (!f[3].is_empty()).then(|| f[3].to_string()),
                upstream: (!f[4].is_empty()).then(|| f[4].to_string()),
            })
        })
        .collect())
}

fn short(full: &str) -> &str {
    full.strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/remotes/"))
        .or_else(|| full.strip_prefix("refs/tags/"))
        .unwrap_or(full)
}

pub fn ref_labels(entries: &[RefEntry]) -> HashMap<String, Vec<RefLabel>> {
    let mut map: HashMap<String, Vec<RefLabel>> = HashMap::new();
    for e in entries.iter().filter(|e| e.symref.is_none()) {
        let kind = if e.full.starts_with("refs/heads/") {
            "branch"
        } else if e.full.starts_with("refs/remotes/") {
            "remote"
        } else {
            "tag"
        };
        map.entry(e.target.clone()).or_default().push(RefLabel { name: short(&e.full).to_string(), kind });
    }
    map
}

pub fn branches(entries: &[RefEntry]) -> Vec<BranchRef> {
    let mut list: Vec<BranchRef> = entries
        .iter()
        .filter(|e| e.symref.is_none())
        .filter(|e| e.full.starts_with("refs/heads/") || e.full.starts_with("refs/remotes/"))
        .map(|e| BranchRef { name: short(&e.full).to_string(), tip: e.target.clone(), remote: e.full.starts_with("refs/remotes/") })
        .collect();
    list.sort_by(|a, b| a.remote.cmp(&b.remote).then_with(|| a.name.cmp(&b.name)));
    list
}

// ---------- integration branch ----------

pub fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> bool {
    ancestor == descendant
        || matches!(git::code(dir, &["merge-base", "--is-ancestor", ancestor, descendant]), Ok((0, _)))
}

/// Override → origin/HEAD → main/master → main worktree branch. The tip is the newer of the
/// local branch and its upstream when one contains the other, the local one when they diverged.
pub fn resolve_trunk(dir: &Path, override_name: Option<&str>, entries: &[RefEntry], trees: &[Worktree]) -> Option<Trunk> {
    let find = |full: &str| entries.iter().find(|e| e.full == full && e.symref.is_none());
    let exists = |name: &str| find(&format!("refs/heads/{name}")).is_some() || find(&format!("refs/remotes/{name}")).is_some();

    let name: String = override_name
        .filter(|n| exists(n))
        .map(str::to_string)
        .or_else(|| {
            entries
                .iter()
                .find(|e| e.full == "refs/remotes/origin/HEAD")
                .and_then(|e| e.symref.as_deref())
                .and_then(|s| s.strip_prefix("refs/remotes/origin/"))
                .map(str::to_string)
        })
        .or_else(|| ["main", "master"].into_iter().find(|n| exists(n) || exists(&format!("origin/{n}"))).map(str::to_string))
        .or_else(|| trees.iter().find(|t| t.is_main).and_then(|t| t.branch.clone()))?;

    let local = find(&format!("refs/heads/{name}"));
    let (remote_full, display) = match local {
        Some(l) => {
            let upstream = l.upstream.clone().filter(|u| find(u).is_some());
            let fallback = format!("refs/remotes/origin/{name}");
            (upstream.or_else(|| find(&fallback).map(|_| fallback)), name.clone())
        }
        // An override like `origin/main`, or a trunk that only exists remotely.
        None => {
            let full = if find(&format!("refs/remotes/{name}")).is_some() {
                format!("refs/remotes/{name}")
            } else {
                format!("refs/remotes/origin/{name}")
            };
            let display = name.split_once('/').map(|(_, b)| b.to_string()).filter(|_| name.starts_with("origin/")).unwrap_or(name.clone());
            (find(&full).map(|_| full), display)
        }
    };
    let remote = remote_full.as_deref().and_then(find);
    let local_tip = local.map(|l| l.target.clone());
    let remote_tip = remote.map(|r| r.target.clone());

    let (tip, tip_ref) = match (&local_tip, &remote_tip) {
        (Some(l), Some(r)) if l != r && is_ancestor(dir, l, r) => (r.clone(), short(remote_full.as_deref().unwrap()).to_string()),
        (Some(l), _) => (l.clone(), name.clone()),
        (None, Some(r)) => (r.clone(), short(remote_full.as_deref().unwrap()).to_string()),
        (None, None) => return None,
    };
    Some(Trunk {
        name: display,
        tip_ref,
        tip,
        local_tip,
        remote_ref: remote_full.as_deref().map(|f| short(f).to_string()),
        remote_tip,
        overridden: override_name.is_some_and(|n| exists(n)),
    })
}

// ---------- status ----------

#[derive(Debug, Default, PartialEq)]
pub struct Counts {
    pub files: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

/// `git status --porcelain=v2 -z`: X counts as staged, Y as unstaged; renames carry an extra path token.
pub fn parse_status(bytes: &[u8]) -> Counts {
    let mut c = Counts::default();
    let tokens = git::nul_tokens(bytes);
    let mut i = 0;
    while i < tokens.len() {
        let t = &tokens[i];
        let mut chars = t.chars();
        match chars.next() {
            Some('1') | Some('2') => {
                let xy: Vec<char> = t.chars().skip(2).take(2).collect();
                c.files += 1;
                if xy.first().is_some_and(|x| *x != '.') {
                    c.staged += 1;
                }
                if xy.get(1).is_some_and(|y| *y != '.') {
                    c.unstaged += 1;
                }
                if t.starts_with('2') {
                    i += 1;
                }
            }
            Some('u') => {
                c.files += 1;
                c.conflicted += 1;
            }
            Some('?') => {
                c.files += 1;
                c.untracked += 1;
            }
            _ => {}
        }
        i += 1;
    }
    c
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

pub fn operation(tree: &Path) -> Option<&'static str> {
    operation_in(&git_dir_of(tree)?)
}

/// The operation in progress, by the files in a worktree's own git dir.
pub fn operation_in(dir: &Path) -> Option<&'static str> {
    [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .into_iter()
    .find(|(f, _)| dir.join(f).exists())
    .map(|(_, op)| op)
}

pub fn ahead_behind(dir: &Path, base: &str, tip: &str) -> Result<(u32, u32)> {
    let out = git::text(dir, &["rev-list", "--left-right", "--count", &format!("{base}...{tip}")])?;
    let mut parts = out.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
    let behind = parts.next().unwrap_or(0);
    let ahead = parts.next().unwrap_or(0);
    Ok((ahead, behind))
}

/// Squash / rebase merges: merging the tip into the base produces exactly the base's tree.
///
/// `merge-tree --write-tree` writes the merged trees (and conflict blobs) as objects, so it runs
/// against a throwaway object directory that borrows the repository's objects as an alternate:
/// the repository itself is never written to.
pub fn content_merged(dir: &Path, base: &str, tip: &str) -> bool {
    let Ok(objects) = git::text(dir, &["rev-parse", "--path-format=absolute", "--git-path", "objects"]) else { return false };
    let Some(scratch) = git::ScratchDir::new("merge-tree") else { return false };
    // Git splits this variable on ':'; a C-style quoted entry is taken as one path.
    let alternate = format!("\"{}\"", objects.trim().replace('\\', "\\\\").replace('"', "\\\""));
    let env = [
        ("GIT_OBJECT_DIRECTORY", scratch.path().as_os_str()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", std::ffi::OsStr::new(&alternate)),
    ];
    let Ok((0, out)) = git::code_with_env(dir, &["merge-tree", "--write-tree", base, tip], &env) else { return false };
    let merged = String::from_utf8_lossy(&out).lines().next().unwrap_or("").trim().to_string();
    let Ok(base_tree) = git::text(dir, &["rev-parse", &format!("{base}^{{tree}}")]) else { return false };
    !merged.is_empty() && merged == base_tree.trim()
}

/// Squash merges `content_merged` misses because the trunk later changed the same lines: the
/// branch's whole change has the same patch-id as one trunk commit since the merge base. Diffs are
/// taken with no context lines, so later edits next to the change don't matter either; whitespace
/// does (`--verbatim`: a re-indent is not the same change). Read-only. Bounded, because it runs
/// again for every unmerged branch whenever the trunk moves; past the bounds the answer is "not
/// merged", the safe side.
pub fn patch_merged(dir: &Path, base: &str, tip: &str) -> bool {
    /// A branch touching more files than this is not worth the scan (and the argument list).
    const MAX_PATHS: usize = 500;
    /// Trunk commits scanned, oldest first: a squash lands soon after the merge base.
    const MAX_COMMITS: usize = 500;
    const MAX_LOG: usize = 16 * 1024 * 1024;
    let opts = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0"];
    let Ok(mb) = git::text(dir, &["merge-base", base, tip]) else { return false };
    let mb = mb.trim();
    let Ok(names) = git::run(dir, &["diff", "--name-only", "-z", "--no-renames", mb, tip]) else { return false };
    let paths: Vec<String> = git::nul_tokens(&names).into_iter().map(|p| format!(":(literal){p}")).collect();
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return false;
    }
    let patch_id = |input: Vec<u8>| git::run_with_input(dir, &["patch-id", "--verbatim"], input).map(|out| String::from_utf8_lossy(&out).into_owned());
    let mut args = vec!["diff"];
    args.extend(opts);
    args.extend([mb, tip]);
    let Ok(own) = git::run(dir, &args).and_then(patch_id) else { return false };
    let Some(own) = own.split_whitespace().next().map(str::to_string) else { return false };

    let range = format!("{mb}..{base}");
    let mut args = vec!["rev-list", "--reverse", "--no-merges", range.as_str(), "--"];
    args.extend(paths.iter().map(String::as_str));
    let Ok(commits) = git::text(dir, &args) else { return false };
    let oldest: Vec<&str> = commits.lines().take(MAX_COMMITS).collect();
    if oldest.is_empty() {
        return false;
    }
    let mut args = vec!["log", "--no-walk=unsorted", "--stdin", "--format=commit %H", "-p"];
    args.extend(opts);
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    let Ok((log, false)) = git::run_limited_with_input(dir, &args, Some((oldest.join("\n") + "\n").into_bytes()), MAX_LOG) else { return false };
    patch_id(log).is_ok_and(|ids| ids.lines().any(|l| l.split_whitespace().next() == Some(own.as_str())))
}

/// Keyed by every input of the answer: branch tip and all trunk tips (local and remote).
pub type IntegrationCache = std::sync::Mutex<HashMap<String, TrunkCompare>>;

pub fn compare_with_trunk(dir: &Path, trunk: &Trunk, tip: &str, cache: &IntegrationCache) -> Result<TrunkCompare> {
    let key = format!(
        "{} {tip} {} {} {}",
        dir.display(),
        trunk.tip,
        trunk.local_tip.as_deref().unwrap_or("-"),
        trunk.remote_tip.as_deref().unwrap_or("-")
    );
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(hit);
    }
    let (ahead, behind) = ahead_behind(dir, &trunk.tip, tip)?;
    let integration = if ahead == 0 {
        Integration::Ancestor
    } else {
        // Also check the other side of a diverged local/remote pair: a PR squashed on the
        // remote while local main has unpushed commits.
        let mut bases = vec![trunk.tip.clone()];
        for other in [&trunk.local_tip, &trunk.remote_tip].into_iter().flatten() {
            if !bases.contains(other) {
                bases.push(other.clone());
            }
        }
        if bases.iter().skip(1).any(|b| is_ancestor(dir, tip, b)) {
            Integration::Ancestor
        } else if bases.iter().any(|b| content_merged(dir, b, tip)) || bases.iter().any(|b| patch_merged(dir, b, tip)) {
            Integration::Squash
        } else {
            Integration::None
        }
    };
    let result = TrunkCompare { ahead, behind, integration };
    if let Ok(mut c) = cache.lock() {
        if c.len() > 4096 {
            c.clear();
        }
        c.insert(key, result.clone());
    }
    Ok(result)
}

/// File counts for one worktree. Status runs with `--untracked-files=normal` (an untracked folder
/// is one entry, ~3x faster than `all` on big trees); only those folders are then listed, so the
/// count matches the file-by-file changes list.
pub fn worktree_counts(tree: &Path) -> Result<Counts> {
    let out = git::run_heavy(tree, &["status", "--porcelain=v2", "-z", "--untracked-files=normal"])?;
    let mut c = parse_status(&out);
    let dirs: Vec<String> = git::nul_tokens(&out)
        .into_iter()
        .filter_map(|t| t.strip_prefix("? ").map(str::to_string))
        .filter(|p| p.ends_with('/'))
        .collect();
    if !dirs.is_empty() {
        let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
        args.extend(dirs.iter().map(String::as_str));
        let inside = git::nul_tokens(&git::run(tree, &args)?).len() as u32;
        let d = dirs.len() as u32;
        c.untracked = c.untracked - d + inside;
        c.files = c.files - d + inside;
    }
    Ok(c)
}

pub fn tree_status(dir: &Path, tree: &Worktree, trunk: Option<&Trunk>, cache: &IntegrationCache) -> TreeStatus {
    let path = Path::new(&tree.path);
    let mut status = TreeStatus {
        path: tree.path.clone(),
        head: tree.head.clone(),
        files: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        operation: None,
        trunk: None,
        error: None,
        missing: false,
    };
    if tree.bare {
        return status;
    }
    if tree.prunable || !path.is_dir() {
        status.missing = !path.exists();
        if !status.missing {
            status.error = Some(tr!("目录还在，但已经不是 worktree（里面的 .git 不见了）", "The folder is there but no longer a worktree (its .git is gone)"));
            return status;
        }
        status.error = Some(tr!("这棵 worktree 的目录已经不存在", "This worktree's folder no longer exists"));
        // Its recorded HEAD decides whether the record can be cleaned up.
        if let (Some(trunk), Some(head)) = (trunk, tree.head.as_deref()) {
            status.trunk = compare_with_trunk(dir, trunk, head, cache).ok();
        }
        return status;
    }
    match worktree_counts(path) {
        Ok(c) => {
            status.files = c.files;
            status.staged = c.staged;
            status.unstaged = c.unstaged;
            status.untracked = c.untracked;
            status.conflicted = c.conflicted;
        }
        Err(e) => status.error = Some(format!("{e:#}")),
    }
    status.operation = operation(path);
    let on_trunk_branch = trunk.is_some_and(|t| tree.branch.as_deref() == Some(t.name.as_str()));
    if let (Some(trunk), Some(head)) = (trunk, tree.head.as_deref()) {
        if !(on_trunk_branch && tree.is_main) {
            status.trunk = compare_with_trunk(dir, trunk, head, cache).ok();
        }
    }
    status
}

pub fn last_commit_time(dir: &Path) -> Option<i64> {
    let out = git::text(dir, &["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:unix)", "refs/heads"]).ok()?;
    out.trim().parse().ok()
}

/// The repository's page on GitHub (or a GitHub Enterprise host), from the remote the trunk
/// tracks (else `origin`, else the first remote). Credentials in the URL never make it out.
pub fn web_url(dir: &Path, trunk: Option<&Trunk>) -> Option<String> {
    let name = primary_remote(dir, trunk)?;
    github_web_url(&git::text(dir, &["remote", "get-url", &name]).ok()?)
}

/// The remote `web_url` reads: the one the trunk tracks, else `origin`, else the first.
pub fn primary_remote(dir: &Path, trunk: Option<&Trunk>) -> Option<String> {
    let remotes = git::text(dir, &["remote"]).ok()?;
    let names: Vec<&str> = remotes.lines().map(str::trim).filter(|n| !n.is_empty()).collect();
    let tracked = trunk.and_then(|t| t.tip_ref.split_once('/')).map(|(remote, _)| remote).filter(|r| names.contains(r));
    tracked.or_else(|| names.iter().copied().find(|n| *n == "origin")).or_else(|| names.first().copied()).map(str::to_string)
}

/// `git@github.com:o/r.git`, `ssh://git@github.com:22/o/r`, `https://token@github.com/o/r.git` → `https://github.com/o/r`.
pub fn github_web_url(remote: &str) -> Option<String> {
    let url = remote.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let (host, path) = if let Some(rest) = url.strip_prefix("ssh://").or_else(|| url.strip_prefix("https://")).or_else(|| url.strip_prefix("http://")) {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
        let (host, path) = rest.split_once('/')?;
        (host.split(':').next()?, path)
    } else {
        // scp-like: [user@]host:owner/repo
        let rest = url.split_once('@').map_or(url, |(_, r)| r);
        rest.split_once(':')?
    };
    if !host.to_ascii_lowercase().contains("github") {
        return None;
    }
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if parts.len() != 2 || !parts.iter().all(|p| ok(p)) {
        return None;
    }
    Some(format!("https://{host}/{}/{}", parts[0], parts[1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_list() {
        let raw = b"worktree /r/main\0HEAD aaa\0branch refs/heads/main\0\0worktree /r/wt\0HEAD bbb\0detached\0locked\0\0worktree /r/gone\0HEAD ccc\0branch refs/heads/x\0prunable gitdir file points to non-existent location\0\0worktree /r/new\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/fresh\0\0";
        let trees = parse_worktrees(raw);
        assert_eq!(trees.len(), 4);
        assert_eq!(trees[3].head, None, "unborn HEAD is not a commit");
        assert!(trees[0].is_main && trees[0].branch.as_deref() == Some("main"));
        assert!(!trees[1].is_main && trees[1].branch.is_none() && trees[1].locked);
        assert!(trees[2].prunable);
    }

    #[test]
    fn parses_status_counts() {
        let raw = b"1 M. N... 100644 100644 100644 a b src/a.rs\x001 .M N... 100644 100644 100644 a b src/b.rs\x002 R. N... 100644 100644 100644 a b R100 new.rs\x00old.rs\x00u UU N... 1 1 1 1 a b c conflict.rs\x00? notes.md\x00";
        let c = parse_status(raw);
        assert_eq!(c, Counts { files: 5, staged: 2, unstaged: 1, untracked: 1, conflicted: 1 });
    }

    #[test]
    fn github_web_url_from_remote_urls() {
        for url in [
            "git@github.com:jimlin/retrace.git",
            "https://github.com/jimlin/retrace",
            "https://x-access-token:secret@github.com/jimlin/retrace.git/",
            "ssh://git@github.com:22/jimlin/retrace.git",
        ] {
            assert_eq!(github_web_url(url).as_deref(), Some("https://github.com/jimlin/retrace"), "{url}");
        }
        assert_eq!(github_web_url("git@github.example.com:team/app.git").as_deref(), Some("https://github.example.com/team/app"));
        assert_eq!(github_web_url("https://gitlab.com/jimlin/retrace.git"), None);
        assert_eq!(github_web_url("/home/me/repos/retrace.git"), None);
        assert_eq!(github_web_url("https://github.com/jimlin"), None);
    }
}
