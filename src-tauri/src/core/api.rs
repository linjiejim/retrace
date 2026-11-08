//! The one entry point the frontend calls: `dispatch(cmd, args)`. The Tauri command and the
//! dev bridge both forward here, so the command table exists once.

use crate::tr;
use super::config::{self, GroupEntry, Prefs, ProjectEntry};
use super::model::*;
use super::{cleanup, diff, files, git, history, repo, State};
use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn args<T: DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).with_context(|| tr!("参数格式不对", "Malformed arguments"))
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

fn project_dir(state: &State, id: &str) -> Result<PathBuf> {
    let known = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().any(|p| p.path == id);
    if !known {
        bail!(tr!("没有这个项目：{id}", "No such project: {id}"));
    }
    let dir = PathBuf::from(id);
    if !dir.is_dir() {
        bail!(tr!("项目目录不存在：{id}", "Project folder not found: {id}"));
    }
    Ok(dir)
}

/// Worktree paths come from the frontend; only accept ones git lists for this project.
fn checked_tree(dir: &Path, tree: &str) -> Result<()> {
    let trees = repo::worktrees(dir)?;
    if trees.iter().any(|t| t.path == tree) {
        Ok(())
    } else {
        bail!(tr!("不是这个项目的 worktree：{tree}", "Not a worktree of this project: {tree}"))
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
        bail!(tr!("提交标识无效", "Invalid commit id"));
    }
    Ok(())
}

fn save(state: &State) -> Result<()> {
    let cfg = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.clone();
    config::save(&state.config_path, &cfg)
}

fn project_of(entry: &ProjectEntry) -> Project {
    Project { id: entry.path.clone(), name: repo::display_name(Path::new(&entry.path)), trunk_override: entry.trunk.clone(), group: entry.group.clone(), pinned: entry.pinned }
}

fn group_of(entry: &GroupEntry) -> Group {
    Group { id: entry.id.clone(), name: entry.name.clone() }
}

fn group_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!(tr!("分组名不能为空", "A group needs a name"));
    }
    Ok(name.chars().take(80).collect())
}

/// A fresh group id: unique in this config, stable once saved.
fn new_group_id(groups: &[GroupEntry]) -> String {
    let base = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut n = 0u32;
    loop {
        let id = format!("g{base:x}{}", if n == 0 { String::new() } else { format!("-{n}") });
        if !groups.iter().any(|g| g.id == id) {
            return id;
        }
        n += 1;
    }
}

fn add_roots(state: &State, roots: Vec<PathBuf>) -> Result<Vec<Project>> {
    let mut added = Vec::new();
    {
        let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
        for root in roots {
            let path = root.to_string_lossy().into_owned();
            if !cfg.projects.iter().any(|p| p.path == path) {
                let entry = ProjectEntry { path, ..Default::default() };
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
            let cfg = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
            json!(cfg.projects.iter().map(project_of).collect::<Vec<_>>())
        }
        "projectSummary" => {
            let Id { id } = args(a)?;
            let dir = PathBuf::from(&id);
            if !state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().any(|p| p.path == id) {
                bail!(tr!("没有这个项目：{id}", "No such project: {id}"));
            }
            if !dir.is_dir() {
                return Ok(json!(ProjectSummary { id, missing: true, last_commit_at: None, linked_trees: 0, dirty_trees: 0, web_url: None }));
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
            // The trunk isn't resolved here, so this is `origin` (else the first remote): the clone's own repository.
            let web_url = repo::web_url(&dir, None);
            json!(ProjectSummary { id, missing: false, last_commit_at: repo::last_commit_time(&dir), linked_trees: linked.len(), dirty_trees: dirty, web_url })
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
                    let known: Vec<String> = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().map(|p| p.path.clone()).collect();
                    let candidates = repo::scan_children(&path, &known);
                    if candidates.is_empty() {
                        bail!(tr!("这个文件夹不是 git 仓库，里面也没有仓库", "This folder isn't a git repository and holds none"));
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
        "listGroups" => {
            let cfg = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
            json!(cfg.groups.iter().map(group_of).collect::<Vec<_>>())
        }
        "createGroup" => {
            #[derive(Deserialize)]
            struct A {
                name: String,
                #[serde(default)]
                projects: Vec<String>,
                /// Where to put it among the groups; the end when absent.
                index: Option<usize>,
            }
            let A { name, projects, index } = args(a)?;
            let name = group_name(&name)?;
            let group = {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                let entry = GroupEntry { id: new_group_id(&cfg.groups), name };
                let at = index.unwrap_or(usize::MAX).min(cfg.groups.len());
                cfg.groups.insert(at, entry.clone());
                for p in cfg.projects.iter_mut().filter(|p| projects.contains(&p.path)) {
                    p.group = Some(entry.id.clone());
                }
                entry
            };
            save(state)?;
            json!(group_of(&group))
        }
        "renameGroup" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                name: String,
            }
            let A { id, name } = args(a)?;
            let name = group_name(&name)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                let g = cfg.groups.iter_mut().find(|g| g.id == id).ok_or_else(|| anyhow!(tr!("没有这个分组", "No such group")))?;
                g.name = name;
            }
            save(state)?;
            Value::Null
        }
        "deleteGroup" => {
            // The projects stay in the list, ungrouped.
            let Id { id } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                cfg.groups.retain(|g| g.id != id);
                for p in cfg.projects.iter_mut().filter(|p| p.group.as_deref() == Some(id.as_str())) {
                    p.group = None;
                }
            }
            save(state)?;
            Value::Null
        }
        "reorderGroups" => {
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
            }
            let A { ids } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                let rank = |g: &str| ids.iter().position(|i| i == g).unwrap_or(usize::MAX);
                cfg.groups.sort_by_key(|g| rank(&g.id));
            }
            save(state)?;
            Value::Null
        }
        "setProjectGroup" => {
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
                group: Option<String>,
            }
            let A { ids, group } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                if let Some(g) = &group {
                    if !cfg.groups.iter().any(|x| &x.id == g) {
                        bail!(tr!("没有这个分组", "No such group"));
                    }
                }
                for p in cfg.projects.iter_mut().filter(|p| ids.contains(&p.path)) {
                    p.group = group.clone();
                }
            }
            save(state)?;
            Value::Null
        }
        "setProjectPinned" => {
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
                pinned: bool,
            }
            let A { ids, pinned } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                for p in cfg.projects.iter_mut().filter(|p| ids.contains(&p.path)) {
                    p.pinned = pinned;
                }
            }
            save(state)?;
            Value::Null
        }
        "removeProject" => {
            let Id { id } = args(a)?;
            state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.retain(|p| p.path != id);
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
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                let entry = cfg.projects.iter_mut().find(|p| p.path == id).ok_or_else(|| anyhow!(tr!("没有这个项目", "No such project")))?;
                entry.trunk = branch.filter(|b| !b.trim().is_empty());
            }
            save(state)?;
            Value::Null
        }
        "overview" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            let entry = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
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
            let entry = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
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
            let entry = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
            let trees = repo::worktrees(&dir)?;
            let refs = repo::refs(&dir)?;
            let trunk = repo::resolve_trunk(&dir, entry.trunk.as_deref(), &refs, &trees).ok_or_else(|| anyhow!(tr!("没有找到集成分支", "No integration branch found")))?;
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
                /// Only this file's history.
                path: Option<String>,
            }
            let A { id, trunk_tip, tip, worktree_head, all_branches, remotes, offset, count, tips: snapshot, path } = args(a)?;
            let dir = project_dir(state, &id)?;
            let path = path.filter(|p| !p.is_empty());
            if path.as_deref().is_some_and(|p| p.starts_with('/') || p.contains('\0') || p.split('/').any(|s| s == "..")) {
                bail!(tr!("文件路径无效", "Invalid file path"));
            }
            for r in [&trunk_tip, &tip, &worktree_head].into_iter().flatten() {
                if r.starts_with('-') {
                    bail!(tr!("提交标识无效", "Invalid commit id"));
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
                bail!(tr!("提交标识无效", "Invalid commit id"));
            }
            json!(state.history.page(history::Query {
                dir: &dir,
                trunk_tip: trunk_tip.as_deref(),
                tips,
                worktree_head: worktree_head.as_deref(),
                path: path.as_deref(),
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
                bail!(tr!("提交标识无效", "Invalid commit id"));
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
            let browser = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.prefs.browser.clone();
            open_url(&url, &browser)?;
            Value::Null
        }
        "reorderProjects" => {
            #[derive(Deserialize)]
            struct Moved {
                id: String,
                group: Option<String>,
                /// Dragged into or out of the pinned projects; unchanged when absent.
                #[serde(default)]
                pinned: Option<bool>,
            }
            #[derive(Deserialize)]
            struct A {
                ids: Vec<String>,
                /// A project dragged into (or out of) a group or the pinned ones, along with the new order.
                moved: Option<Moved>,
            }
            let A { ids, moved } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                let rank = |p: &str| ids.iter().position(|i| i == p).unwrap_or(usize::MAX);
                cfg.projects.sort_by_key(|p| rank(&p.path));
                if let Some(Moved { id, group, pinned }) = moved {
                    let group = group.filter(|g| cfg.groups.iter().any(|x| &x.id == g));
                    if let Some(p) = cfg.projects.iter_mut().find(|p| p.path == id) {
                        p.group = group;
                        if let Some(pinned) = pinned {
                            p.pinned = pinned;
                        }
                    }
                }
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
                #[serde(default)]
                delete_remote: bool,
            }
            let A { id, path, head, acknowledged_ignored, delete_branch, delete_remote } = args(a)?;
            let dir = project_dir(state, &id)?;
            let (trunk, _) = trunk_and_trees(state, &id, &dir)?;
            let trunk = trunk.ok_or_else(|| anyhow!(tr!("没有找到集成分支", "No integration branch found")))?;
            let outcome = cleanup::remove(&dir, &trunk, &path, &head, &acknowledged_ignored, delete_branch, delete_remote, &kept_branches(state, &id)?, &state.integration)?;
            if let Some(deleted) = outcome.deleted.clone() {
                remember_deleted(state, &id, deleted);
            }
            json!(outcome)
        }
        "branchStatuses" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            let entry = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
            let trees = repo::worktrees(&dir)?;
            let refs = repo::refs(&dir)?;
            match repo::resolve_trunk(&dir, entry.trunk.as_deref(), &refs, &trees) {
                Some(trunk) => json!(cleanup::branch_statuses(&dir, &trunk, &refs, &trees, &entry.kept_branches, &state.integration)),
                None => json!(Vec::<BranchStatus>::new()),
            }
        }
        "deleteBranch" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                id: String,
                name: String,
                tip: String,
                #[serde(default)]
                delete_remote: bool,
            }
            let A { id, name, tip, delete_remote } = args(a)?;
            let dir = project_dir(state, &id)?;
            let (trunk, _) = trunk_and_trees(state, &id, &dir)?;
            let trunk = trunk.ok_or_else(|| anyhow!(tr!("没有找到集成分支", "No integration branch found")))?;
            let (deleted, remote) = cleanup::delete_branch(&dir, &trunk, &name, &tip, delete_remote, &kept_branches(state, &id)?, &state.integration)?;
            remember_deleted(state, &id, deleted);
            json!(remote)
        }
        "restoreBranch" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                name: String,
            }
            let A { id, name } = args(a)?;
            let dir = project_dir(state, &id)?;
            let key = format!("{id}\0{name}");
            let deleted = state.deleted_branches.lock().ok().and_then(|d| d.get(&key).cloned());
            let deleted = deleted.ok_or_else(|| anyhow!(tr!("只能恢复刚才删掉的分支", "Only branches deleted here can be restored")))?;
            // Once the branch is back the record is spent, even if some settings couldn't be written.
            let settings_failed = cleanup::restore_branch(&dir, &deleted)?;
            if let Ok(mut deleted) = state.deleted_branches.lock() {
                deleted.remove(&key);
            }
            json!({ "settingsFailed": settings_failed })
        }
        "keepBranch" => {
            #[derive(Deserialize)]
            struct A {
                id: String,
                name: String,
                keep: bool,
            }
            let A { id, name, keep } = args(a)?;
            {
                let mut cfg = state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
                let entry = cfg.projects.iter_mut().find(|p| p.path == id).ok_or_else(|| anyhow!(tr!("没有这个项目", "No such project")))?;
                entry.kept_branches.retain(|b| *b != name);
                if keep {
                    entry.kept_branches.push(name);
                    entry.kept_branches.sort();
                }
            }
            save(state)?;
            Value::Null
        }
        "fetch" => {
            let Id { id } = args(a)?;
            let dir = project_dir(state, &id)?;
            fetch(&dir)?;
            Value::Null
        }
        "setLanguage" => {
            #[derive(Deserialize)]
            struct A {
                lang: String,
            }
            let A { lang } = args(a)?;
            super::i18n::set(&lang);
            Value::Null
        }
        "getPrefs" => json!(state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.prefs),
        "setPrefs" => {
            let prefs: Prefs = args(a)?;
            state.config.write().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.prefs = prefs;
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
            let target = std::fs::canonicalize(&path).map_err(|_| anyhow!(tr!("路径不存在：{path}", "Path not found: {path}")))?;
            let trees = repo::worktrees(&dir)?;
            let inside = trees.iter().filter_map(|t| std::fs::canonicalize(&t.path).ok()).any(|root| target.starts_with(root));
            if !inside {
                bail!(tr!("只能打开这个项目里的路径", "Only paths inside this project can be opened"));
            }
            open_with(state, &target.to_string_lossy(), &with)?;
            Value::Null
        }
        _ => bail!(tr!("未知命令：{cmd}", "Unknown command: {cmd}")),
    })
}

/// Undo can bring back only what was recorded here.
fn remember_deleted(state: &State, id: &str, deleted: DeletedBranch) {
    if let Ok(mut map) = state.deleted_branches.lock() {
        map.insert(format!("{id}\0{}", deleted.name), deleted);
    }
}

fn kept_branches(state: &State, id: &str) -> Result<Vec<String>> {
    let cfg = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?;
    Ok(cfg.projects.iter().find(|p| p.path == id).map(|p| p.kept_branches.clone()).unwrap_or_default())
}

fn trunk_and_trees(state: &State, id: &str, dir: &Path) -> Result<(Option<Trunk>, Vec<Worktree>)> {
    let entry = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.projects.iter().find(|p| p.path == id).cloned().unwrap_or_default();
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
        bail!(tr!("只能打开网页链接", "Only web links can be opened"));
    }
    let mut cmd = std::process::Command::new("/usr/bin/open");
    if !browser.is_empty() && !url.trim().to_ascii_lowercase().starts_with("mailto:") {
        cmd.args(["-a", browser]);
    }
    let out = cmd.arg(url.trim()).output().with_context(|| tr!("无法调用 open", "Can't run open"))?;
    if !out.status.success() {
        if browser.is_empty() {
            bail!(tr!("打不开这个链接", "Couldn't open the link"));
        }
        bail!(tr!("打不开：找不到「{browser}」，可以在设置里换一个浏览器", "Couldn't open it: “{browser}” isn't installed. Pick another browser in Settings"));
    }
    Ok(())
}

fn open_with(state: &State, path: &str, with: &str) -> Result<()> {
    let prefs = state.config.read().map_err(|_| anyhow!(tr!("配置不可用", "Settings are unavailable")))?.prefs.clone();
    let mut cmd = std::process::Command::new("/usr/bin/open");
    match with {
        "finder" => cmd.arg(path),
        "terminal" => cmd.args(["-a", &prefs.terminal, path]),
        "editor" => cmd.args(["-a", &prefs.editor, path]),
        _ => bail!(tr!("未知的打开方式", "Unknown way to open")),
    };
    let out = cmd.output().with_context(|| tr!("无法调用 open", "Can't run open"))?;
    if !out.status.success() {
        let app = if with == "terminal" { prefs.terminal } else { prefs.editor };
        bail!(tr!("打不开：找不到「{app}」，可以在设置里换一个应用", "Couldn't open it: “{app}” isn't installed. Pick another app in Settings"));
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
