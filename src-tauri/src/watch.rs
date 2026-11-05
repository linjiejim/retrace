//! File watching for the selected project and periodic background fetch.
//! Both report through the `repo-changed` event: `{ id, git, trees }`.

use crate::core::{self, git, repo};
use anyhow::Result;
use notify::{RecursiveMode, Watcher as _};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Changed {
    id: String,
    /// Refs, HEAD or the index moved.
    git: bool,
    /// Worktrees whose files changed.
    trees: Vec<String>,
}

#[derive(Default)]
pub struct Watcher {
    /// Project id, the worktree roots being watched, and the watcher itself.
    active: Mutex<Option<(String, Vec<PathBuf>, notify::RecommendedWatcher)>>,
}

/// Build output and dependency folders change constantly and never matter for review.
const NOISY: [&str; 14] = [
    "/node_modules/", "/target/", "/.build/", "/dist/", "/build/", "/.next/", "/.turbo/", "/DerivedData/", "/.venv/", "/__pycache__/",
    "/.gradle/", "/.cache/", "/.pnpm-store/", "/.DS_Store",
];

impl Watcher {
    pub fn watch(&self, app: AppHandle, id: Option<String>) -> Result<()> {
        let mut active = self.active.lock().map_err(|_| anyhow::anyhow!("watcher poisoned"))?;
        let Some(id) = id else {
            *active = None;
            return Ok(());
        };

        let dir = PathBuf::from(&id);
        let common = PathBuf::from(git::text(&dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim());
        let common = std::fs::canonicalize(&common).unwrap_or(common);
        let mut roots: Vec<PathBuf> = repo::worktrees(&dir)?
            .into_iter()
            .filter(|t| !t.bare && Path::new(&t.path).is_dir())
            .map(|t| std::fs::canonicalize(&t.path).unwrap_or_else(|_| PathBuf::from(&t.path)))
            .collect();
        roots.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
        // Same project, same worktrees: keep the running watcher. A new or removed worktree rebuilds it.
        if active.as_ref().is_some_and(|(current, watched, _)| *current == id && *watched == roots) {
            return Ok(());
        }
        *active = None;

        let (tx, rx) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for p in event.paths {
                    let _ = tx.send(p);
                }
            }
        })?;
        watcher.watch(&common, RecursiveMode::Recursive)?;
        let mut watched: Vec<&PathBuf> = vec![&common];
        let mut by_len = roots.clone();
        by_len.sort_by_key(|p| p.as_os_str().len());
        for root in &by_len {
            if watched.iter().any(|w| root.starts_with(w)) {
                continue;
            }
            if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
                watched.push(root);
            }
        }

        let project = id.clone();
        let watched_roots = roots.clone();
        std::thread::spawn(move || debounce(app, project, common, roots, rx));
        *active = Some((id, watched_roots, watcher));
        Ok(())
    }
}

fn debounce(app: AppHandle, id: String, common: PathBuf, roots: Vec<PathBuf>, rx: mpsc::Receiver<PathBuf>) {
    let mut last_emit = Instant::now() - Duration::from_secs(10);
    // Ends when the watcher (which owns the sender) is dropped.
    while let Ok(first) = rx.recv() {
        let mut paths = vec![first];
        let window = Instant::now() + Duration::from_millis(700);
        let until = window.max(last_emit + Duration::from_secs(2));
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(p) => paths.push(p),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut git_changed = false;
        let mut index_changed = false;
        let mut trees: HashSet<String> = HashSet::new();
        for p in paths {
            let s = p.to_string_lossy();
            if p.starts_with(&common) {
                if s.contains("/objects/") || s.contains("/lfs/") || s.ends_with(".lock") {
                    continue;
                }
                // Staging (`git add`) only rewrites an index: statuses change, refs and history don't.
                if p.file_name().is_some_and(|n| n == "index") {
                    index_changed = true;
                } else {
                    git_changed = true;
                }
            } else if !NOISY.iter().any(|n| s.contains(n)) {
                if let Some(root) = roots.iter().find(|r| p.starts_with(r)) {
                    trees.insert(root.to_string_lossy().into_owned());
                }
            }
        }
        if git_changed || index_changed || !trees.is_empty() {
            last_emit = Instant::now();
            let _ = app.emit("repo-changed", Changed { id: id.clone(), git: git_changed, trees: trees.into_iter().collect() });
        }
    }
}

pub fn start_auto_fetch(app: AppHandle, state: Arc<core::State>) {
    std::thread::spawn(move || {
        let mut last: HashMap<String, Instant> = HashMap::new();
        std::thread::sleep(Duration::from_secs(20));
        loop {
            let (minutes, projects) = match state.config.read() {
                Ok(cfg) => (cfg.prefs.fetch_minutes, cfg.projects.iter().map(|p| p.path.clone()).collect::<Vec<_>>()),
                Err(_) => return,
            };
            if minutes > 0 {
                let every = Duration::from_secs(minutes as u64 * 60);
                for id in projects {
                    if last.get(&id).is_some_and(|t| t.elapsed() < every) {
                        continue;
                    }
                    last.insert(id.clone(), Instant::now());
                    let dir = PathBuf::from(&id);
                    if dir.is_dir() && core::api::fetch(&dir).is_ok() {
                        let _ = app.emit("repo-changed", Changed { id, git: true, trees: vec![] });
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}
