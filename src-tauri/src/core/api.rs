//! The one entry point the frontend calls: `dispatch(cmd, args)`. The Tauri command and the
//! dev bridge both forward here, so the command table exists once.

use super::config::{self, Prefs, ProjectEntry};
use super::model::*;
use super::{cleanup, diff, files, git, history, repo, State};
use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn args<T: DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).context("参数格式不对")
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

fn project_dir(state: &State, id: &str) -> Result<PathBuf> {
    let known = state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().any(|p| p.path == id);
    if !known {
        bail!("没有这个项目：{id}");
    }
    let dir = PathBuf::from(id);
    if !dir.is_dir() {
        bail!("项目目录不存在：{id}");
    }
    Ok(dir)
}

/// Worktree paths come from the frontend; only accept ones git lists for this project.
fn checked_tree(dir: &Path, tree: &str) -> Result<()> {
    let trees = repo::worktrees(dir)?;
    if trees.iter().any(|t| t.path == tree) {
        Ok(())
    } else {
        bail!("不是这个项目的 worktree：{tree}")
    }
}

fn check_target(dir: &Path, target: &Target) -> Result<()> {
    if let Target::Worktree { tree } = target {
        checked_tree(dir, tree)?;
    }
    let revs: Vec<&String> = match target {
        Target::Commit { hash } => vec![hash],
        Target::Compare { base, tip } => vec![base, tip],
        Target::Worktree { .. } => vec![],
    };
    if revs.iter().any(|r| r.starts_with('-')) {
        bail!("提交标识无效");
    }
    Ok(())
}

fn save(state: &State) -> Result<()> {
    let cfg = state.config.read().map_err(|_| anyhow!("配置不可用"))?.clone();
    config::save(&state.config_path, &cfg)
}

fn project_of(entry: &ProjectEntry) -> Project {
    Project { id: entry.path.clone(), name: repo::display_name(Path::new(&entry.path)), trunk_override: entry.trunk.clone() }
}

fn add_roots(state: &State, roots: Vec<PathBuf>) -> Result<Vec<Project>> {
    let mut added = Vec::new();
    {
        let mut cfg = state.config.write().map_err(|_| anyhow!("配置不可用"))?;
        for root in roots {
            let path = root.to_string_lossy().into_owned();
            if !cfg.projects.iter().any(|p| p.path == path) {
                let entry = ProjectEntry { path, trunk: None };
                added.push(project_of(&entry));
                cfg.projects.push(entry);
            }
        }
    }
    save(state)?;
    Ok(added)
}

pub fn dispatch(state: &State, cmd: &str, a: Value) -> Result<Value> {
    Ok(match cmd {
        "listProjects" => {
            let cfg = state.config.read().map_err(|_| anyhow!("配置不可用"))?;
            json!(cfg.projects.iter().map(project_of).collect::<Vec<_>>())
        }
        "projectSummary" => {
            let Id { id } = args(a)?;
            let dir = PathBuf::from(&id);
            if !state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().any(|p| p.path == id) {
                bail!("没有这个项目：{id}");
            }
            if !dir.is_dir() {
                return Ok(json!(ProjectSummary { id, missing: true, last_commit_at: None, linked_trees: 0, dirty_trees: 0 }));
            }
            let trees = repo::worktrees(&dir)?;
            let linked: Vec<_> = trees.iter().filter(|t| !t.is_main && !t.bare).collect();
            let dirty = std::thread::scope(|s| {
                let handles: Vec<_> = trees
                    .iter()
                    .filter(|t| !t.bare && !t.prunable && Path::new(&t.path).is_dir())
                    .map(|t| {
                        s.spawn(move || {
                            git::run_heavy(Path::new(&t.path), &["status", "--porcelain=v2", "-z", "--untracked-files=normal"])
                                .map(|out| repo::parse_status(&out).files > 0)
                                .unwrap_or(false)
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap_or(false)).filter(|d| *d).count()
            });
            json!(ProjectSummary { id, missing: false, last_commit_at: repo::last_commit_time(&dir), linked_trees: linked.len(), dirty_trees: dirty })
        }
        "addPath" => {
            #[derive(Deserialize)]
            struct A {
                path: String,
            }
            let A { path } = args(a)?;
            let path = PathBuf::from(path);
            match repo::project_root(&path) {
                Ok(root) => json!(AddResult { added: add_roots(state, vec![root])?, candidates: vec![] }),
                Err(_) => {
                    let known: Vec<String> = state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().map(|p| p.path.clone()).collect();
                    let candidates = repo::scan_children(&path, &known);
                    if candidates.is_empty() {
                        bail!("这个文件夹不是 git 仓库，里面也没有仓库");
                    }
                    json!(AddResult { added: vec![], candidates })
                }
            }
        }
        "addProjects" => {
            #[derive(Deserialize)]
            struct A {
                paths: Vec<String>,
            }
            let A { paths } = args(a)?;
            let roots = paths.iter().filter_map(|p| repo::project_root(Path::new(p)).ok()).collect();
            json!(add_roots(state, roots)?)
        }
        "removeProject" => {
            let Id { id } = args(a)?;
            state.config.write().map_err(|_| anyhow!("配置不可用"))?.projects.retain(|p| p.path != id);
            save(state)?;
            Value::Null
        }
        "setTrunk" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                branch: Option<String>,
            }
            let A { id, branch } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!("配置不可用"))?;
                let entry = cfg.projects.iter_mut().find(|p| p.path == id).ok_or_else(|| anyhow!("没有这个项目"))?;
                entry.trunk = branch.filter(|b| !b.trim().is_empty());
            }
            save(state)?;
            Value::Null
        }
        "overview" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            let entry = state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
            let trees = repo::worktrees(&dir)?;
            let refs = repo::refs(&dir)?;
            let trunk = repo::resolve_trunk(&dir, entry.trunk.as_deref(), &refs, &trees);
            let has_remote = !git::text(&dir, &["remote"]).unwrap_or_default().trim().is_empty();
            let web_url = if has_remote { repo::web_url(&dir, trunk.as_ref()) } else { None };
            json!(Overview { project: project_of(&entry), trunk, trees, branches: repo::branches(&refs), refs: repo::ref_labels(&refs), has_remote, web_url })
        }
        "treeStatuses" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            let entry = state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
            let trees = repo::worktrees(&dir)?;
            let refs = repo::refs(&dir)?;
            let trunk = repo::resolve_trunk(&dir, entry.trunk.as_deref(), &refs, &trees);
            // Four at a time: big monorepos make `git status` the slow part.
            let mut statuses = Vec::with_capacity(trees.len());
            for chunk in trees.chunks(4) {
                std::thread::scope(|s| {
                    let handles: Vec<_> = chunk.iter().map(|t| s.spawn(|| repo::tree_status(&dir, t, trunk.as_ref(), &state.integration))).collect();
                    for h in handles {
                        if let Ok(st) = h.join() {
                            statuses.push(st);
                        }
                    }
                });
            }
            json!(statuses)
        }
        "compare" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                tip: String,
            }
            let A { id, tip } = args(a)?;
            let dir = project_dir(state, &id)?;
            let entry = state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
            let trees = repo::worktrees(&dir)?;
            let refs = repo::refs(&dir)?;
            let trunk = repo::resolve_trunk(&dir, entry.trunk.as_deref(), &refs, &trees).ok_or_else(|| anyhow!("没有找到集成分支"))?;
            json!(repo::compare_with_trunk(&dir, &trunk, &tip, &state.integration)?)
        }
        "history" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                trunk_tip: Option<String>,
                tip: Option<String>,
                worktree_head: Option<String>,
                #[serde(default)]
                all_branches: bool,
                #[serde(default)]
                remotes: bool,
                #[serde(default)]
                offset: usize,
                count: Option<usize>,
                /// Tips returned by the first page; when set, branches are not resolved again.
                tips: Option<Vec<String>>,
            }
            let A { id, trunk_tip, tip, worktree_head, all_branches, remotes, offset, count, tips: snapshot } = args(a)?;
            let dir = project_dir(state, &id)?;
            for r in [&trunk_tip, &tip, &worktree_head].into_iter().flatten() {
                if r.starts_with('-') {
                    bail!("提交标识无效");
                }
            }
            let tips = match snapshot {
                Some(t) => t,
                None => {
                    let mut t: Vec<String> = tip.into_iter().collect();
                    if all_branches {
                        t.extend(history::branch_tips(&dir, remotes)?);
                    }
                    t
                }
            };
            if tips.iter().any(|t| t.starts_with('-')) {
                bail!("提交标识无效");
            }
            json!(state.history.page(history::Query {
                dir: &dir,
                trunk_tip: trunk_tip.as_deref(),
                tips,
                worktree_head: worktree_head.as_deref(),
                offset,
                count: count.unwrap_or(500).clamp(1, 5000),
            })?)
        }
        "commit" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                hash: String,
            }
            let A { id, hash } = args(a)?;
            let dir = project_dir(state, &id)?;
            if hash.starts_with('-') {
                bail!("提交标识无效");
            }
            json!(history::commit_detail(&dir, &hash)?)
        }
        "changes" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                target: Target,
            }
            let A { id, target } = args(a)?;
            let dir = project_dir(state, &id)?;
            check_target(&dir, &target)?;
            json!(diff::changes(&dir, &target)?)
        }
        "filePair" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                target: Target,
                path: String,
                old_path: Option<String>,
            }
            let A { id, target, path, old_path } = args(a)?;
            let dir = project_dir(state, &id)?;
            check_target(&dir, &target)?;
            json!(diff::file_pair(&dir, &target, &path, old_path.as_deref())?)
        }
        "files" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                target: Target,
            }
            let A { id, target } = args(a)?;
            let dir = project_dir(state, &id)?;
            check_target(&dir, &target)?;
            json!(files::files(&dir, &target)?)
        }
        "fileContent" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                target: Target,
                path: String,
                side: files::Side,
                old_path: Option<String>,
            }
            let A { id, target, path, side, old_path } = args(a)?;
            let dir = project_dir(state, &id)?;
            check_target(&dir, &target)?;
            json!(files::file_content(&dir, &target, &path, side, old_path.as_deref())?)
        }
        "openUrl" => {
            #[derive(Deserialize)]
            struct A {
                url: String,
            }
            let A { url } = args(a)?;
            let browser = state.config.read().map_err(|_| anyhow!("配置不可用"))?.prefs.browser.clone();
            open_url(&url, &browser)?;
            Value::Null
        }
        "reorderProjects" => {
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
            }
            let A { ids } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!("配置不可用"))?;
                let rank = |p: &str| ids.iter().position(|i| i == p).unwrap_or(usize::MAX);
                cfg.projects.sort_by_key(|p| rank(&p.path));
            }
            save(state)?;
            Value::Null
        }
        "patch" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                target: Target,
            }
            let A { id, target } = args(a)?;
            let dir = project_dir(state, &id)?;
            check_target(&dir, &target)?;
            json!(diff::patch(&dir, &target)?)
        }
        "cleanupCandidates" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            let (trunk, trees) = trunk_and_trees(state, &id, &dir)?;
            match trunk {
                Some(trunk) => json!(cleanup::candidates(&dir, &trunk, &trees, &state.integration)),
                None => json!(Vec::<CleanupCandidate>::new()),
            }
        }
        "removeWorktree" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                path: String,
                head: String,
                #[serde(default)]
                acknowledged_ignored: Vec<String>,
                delete_branch: bool,
            }
            let A { id, path, head, acknowledged_ignored, delete_branch } = args(a)?;
            let dir = project_dir(state, &id)?;
            let (trunk, _) = trunk_and_trees(state, &id, &dir)?;
            let trunk = trunk.ok_or_else(|| anyhow!("没有找到集成分支"))?;
            json!(cleanup::remove(&dir, &trunk, &path, &head, &acknowledged_ignored, delete_branch, &state.integration)?)
        }
        "fetch" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            fetch(&dir)?;
            Value::Null
        }
        "getPrefs" => json!(state.config.read().map_err(|_| anyhow!("配置不可用"))?.prefs),
        "setPrefs" => {
            let prefs: Prefs = args(a)?;
            state.config.write().map_err(|_| anyhow!("配置不可用"))?.prefs = prefs;
            save(state)?;
            Value::Null
        }
        "open" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                path: String,
                with: String,
            }
            let A { id, path, with } = args(a)?;
            let dir = project_dir(state, &id)?;
            // Only paths inside this project's worktrees, compared after resolving `..` and symlinks.
            let target = std::fs::canonicalize(&path).map_err(|_| anyhow!("路径不存在：{path}"))?;
            let trees = repo::worktrees(&dir)?;
            let inside = trees.iter().filter_map(|t| std::fs::canonicalize(&t.path).ok()).any(|root| target.starts_with(root));
            if !inside {
                bail!("只能打开这个项目里的路径");
            }
            open_with(state, &target.to_string_lossy(), &with)?;
            Value::Null
        }
        _ => bail!("未知命令：{cmd}"),
    })
}

fn trunk_and_trees(state: &State, id: &str, dir: &Path) -> Result<(Option<Trunk>, Vec<Worktree>)> {
    let entry = state.config.read().map_err(|_| anyhow!("配置不可用"))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
    let trees = repo::worktrees(dir)?;
    let refs = repo::refs(dir)?;
    Ok((repo::resolve_trunk(dir, entry.trunk.as_deref(), &refs, &trees), trees))
}

pub fn fetch(dir: &Path) -> Result<()> {
    if git::text(dir, &["remote"])?.trim().is_empty() {
        return Ok(());
    }
    git::run_with_timeout(dir, &["fetch", "--all", "--prune", "--quiet", "--no-write-fetch-head"], Duration::from_secs(120))
}

/// Links in a previewed Markdown file. Only web and mail links: `open` would also run apps and files.
pub fn link_allowed(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["https://", "http://", "mailto:"].iter().any(|s| lower.starts_with(s)) && !url.chars().any(char::is_control)
}

/// In `browser` (an application name for `open -a`), or the system default when it's empty.
fn open_url(url: &str, browser: &str) -> Result<()> {
    if !link_allowed(url) {
        bail!("只能打开网页链接");
    }
    let mut cmd = std::process::Command::new("/usr/bin/open");
    if !browser.is_empty() && !url.trim().to_ascii_lowercase().starts_with("mailto:") {
        cmd.args(["-a", browser]);
    }
    let out = cmd.arg(url.trim()).output().context("无法调用 open")?;
    if !out.status.success() {
        if browser.is_empty() {
            bail!("打不开这个链接");
        }
        bail!("打不开：找不到「{browser}」，可以在设置里换一个浏览器");
    }
    Ok(())
}

fn open_with(state: &State, path: &str, with: &str) -> Result<()> {
    let prefs = state.config.read().map_err(|_| anyhow!("配置不可用"))?.prefs.clone();
    let mut cmd = std::process::Command::new("/usr/bin/open");
    match with {
        "finder" => cmd.arg(path),
        "terminal" => cmd.args(["-a", &prefs.terminal, path]),
        "editor" => cmd.args(["-a", &prefs.editor, path]),
        _ => bail!("未知的打开方式"),
    };
    let out = cmd.output().context("无法调用 open")?;
    if !out.status.success() {
        let app = if with == "terminal" { prefs.terminal } else { prefs.editor };
        bail!("打不开：找不到「{app}」，可以在设置里换一个应用");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::link_allowed;

    #[test]
    fn only_web_and_mail_links_open() {
        assert!(link_allowed("https://example.com/a?b=c"));
        assert!(link_allowed("HTTP://example.com"));
        assert!(link_allowed("mailto:someone@example.com"));
        assert!(!link_allowed("file:///etc/passwd"));
        assert!(!link_allowed("/Applications/Calculator.app"));
        assert!(!link_allowed("javascript:alert(1)"));
        assert!(!link_allowed("https://example.com/\nx"));
    }
}
