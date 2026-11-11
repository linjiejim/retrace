//! Commit history for one tab, laid out as a graph and served in pages.
//!
//! A `Stream` per (repository, tips, uncommitted row) keeps the rows read so far and the lane state,
//! so the next page only reads and lays out new rows. Tips are commit ids, so a moved branch is a
//! new key and stale streams simply age out of the small cache.
//!
//! With a path, the history is that file's: only commits that change it, with parents rewritten
//! to the nearest such ancestor so the graph still connects.
//!
//! With merges folded, only first-parent chains are walked: a merge stands for everything it
//! brought in, and an expanded merge has those commits laid out right below it.

use super::git;
use super::graph::Lanes;
use super::model::*;
use anyhow::Result;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const WORKTREE_ROW: &str = "WORKTREE";
/// Rows beyond this are not shown (the page says so).
pub const MAX_ROWS: usize = 100_000;
const CACHE_SIZE: usize = 8;
/// An expanded merge shows at most this many of the commits it brought in.
const MAX_MERGED_IN: usize = 5000;
const FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e";

#[derive(Clone)]
struct Raw {
    id: String,
    parents: Vec<String>,
    author: String,
    time: i64,
    subject: String,
}

fn parse_log(text: &str) -> Vec<Raw> {
    text.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            if record.is_empty() {
                return None;
            }
            let f: Vec<&str> = record.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            Some(Raw {
                id: f[0].to_string(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                author: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
                subject: f[4].to_string(),
            })
        })
        .collect()
}

fn row(r: Raw, p: super::graph::Placed, folded: Option<bool>) -> HistoryRow {
    HistoryRow { id: r.id, parents: r.parents, author: r.author, time: r.time, subject: r.subject, col: p.col, color: p.color, segs: p.segs, folded }
}

fn worktree_row(parents: Vec<String>, p: super::graph::Placed) -> HistoryRow {
    row(Raw { id: WORKTREE_ROW.into(), parents, author: String::new(), time: 0, subject: String::new() }, p, None)
}

/// Merges folded: the walk follows first parents only.
struct Fold {
    /// Merges whose merged-in commits are laid out below them.
    expanded: HashSet<String>,
    /// Every commit on the walked first-parent chains; read at the first merge.
    chains: Option<HashSet<String>>,
    /// Rows laid out so far: an edge to one of them would point upwards, so none is drawn.
    placed: HashSet<String>,
}

impl Fold {
    /// Whether an edge to `id` can be drawn: it is laid out further down.
    fn below(&self, id: &str, inner: &HashSet<&str>) -> bool {
        inner.contains(id) || (!self.placed.contains(id) && self.chains.as_ref().is_some_and(|c| c.contains(id)))
    }
}

struct Stream {
    dir: PathBuf,
    revs: Vec<String>,
    /// A literal pathspec (`:(literal)…`) limiting history to one file.
    path: Option<String>,
    worktree_head: Option<String>,
    /// Uncommitted work on a file no commit has touched yet: its row goes first, with no parent.
    worktree_first: bool,
    /// Commits read from git so far (the uncommitted row is not counted).
    read: usize,
    done: bool,
    rows: Vec<HistoryRow>,
    lanes: Lanes,
    fold: Option<Fold>,
}

impl Stream {
    fn new(dir: &Path, trunk_tip: Option<&str>, revs: Vec<String>, path: Option<String>, worktree_head: Option<String>, worktree_first: bool) -> Self {
        Self { dir: dir.to_path_buf(), revs, path, worktree_head, worktree_first, read: 0, done: false, rows: Vec::new(), lanes: Lanes::new(trunk_tip), fold: None }
    }

    /// Lay out one commit read from the walk (and, for an expanded merge, what it brought in).
    fn push(&mut self, r: Raw) -> Result<()> {
        let Some(fold) = self.fold.as_mut() else {
            let p = self.lanes.place(&r.id, &r.parents, false);
            self.rows.push(row(r, p, None));
            return Ok(());
        };
        fold.placed.insert(r.id.clone());
        if r.parents.len() < 2 {
            let p = self.lanes.place(&r.id, &r.parents, false);
            self.rows.push(row(r, p, None));
            return Ok(());
        }
        if fold.chains.is_none() {
            let n = format!("-n{MAX_ROWS}");
            let mut args = vec!["rev-list", "--first-parent", n.as_str()];
            args.extend(self.revs.iter().map(String::as_str));
            args.push("--");
            fold.chains = Some(git::text(&self.dir, &args)?.split_whitespace().map(str::to_string).collect());
        }
        let chains = fold.chains.as_ref().expect("read above");
        // Its other parents are on a drawn chain already (main merged into a branch, or a branch
        // that is drawn too): it brought in nothing of its own, so it is a plain merge with lines
        // to those parents still below.
        if r.parents[1..].iter().all(|p| chains.contains(p) || fold.placed.contains(p)) {
            let none = HashSet::new();
            let mut edges = vec![r.parents[0].clone()];
            edges.extend(r.parents[1..].iter().filter(|p| fold.below(p, &none)).cloned());
            let p = self.lanes.place(&r.id, &edges, false);
            self.rows.push(row(r, p, None));
            return Ok(());
        }
        if !fold.expanded.contains(&r.id) {
            let p = self.lanes.place(&r.id, &r.parents[..1], false);
            self.rows.push(row(r, p, Some(true)));
            return Ok(());
        }
        // What the merge brought in: reachable from its other parents but not its first, minus
        // anything a first-parent chain or an earlier row already shows.
        let n = format!("-n{MAX_MERGED_IN}");
        let mut args = vec!["log", "--topo-order", FORMAT, n.as_str()];
        args.extend(r.parents[1..].iter().map(String::as_str));
        args.extend(["--not", r.parents[0].as_str(), "--"]);
        let merged: Vec<Raw> = parse_log(&git::text(&self.dir, &args)?).into_iter().filter(|m| !chains.contains(&m.id) && !fold.placed.contains(&m.id)).collect();
        let inner: HashSet<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        let drawn = |ps: &[String]| -> Vec<String> { ps.iter().filter(|p| fold.below(p, &inner)).cloned().collect() };
        let mut edges = vec![r.parents[0].clone()];
        edges.extend(drawn(&r.parents[1..]));
        let inner_edges: Vec<Vec<String>> = merged.iter().map(|m| drawn(&m.parents)).collect();
        drop(inner);
        let p = self.lanes.place(&r.id, &edges, false);
        self.rows.push(row(r, p, Some(false)));
        for (m, edges) in merged.into_iter().zip(inner_edges) {
            fold.placed.insert(m.id.clone());
            let p = self.lanes.place(&m.id, &edges, false);
            self.rows.push(row(m, p, None));
        }
        Ok(())
    }

    /// Read and lay out commits until at least `want` rows exist or history ends.
    fn fill(&mut self, want: usize) -> Result<()> {
        if self.worktree_first && self.rows.is_empty() {
            let p = self.lanes.place(WORKTREE_ROW, &[], self.lanes.trunk_lane_free());
            self.rows.push(worktree_row(vec![], p));
        }
        while !self.done && self.rows.len() < want {
            // The topological walk costs about the same for 1k or 10k rows, so read generously.
            let chunk = (want - self.rows.len()).max(self.read).clamp(1000, 20_000);
            let skip = format!("--skip={}", self.read);
            let n = format!("-n{chunk}");
            let mut args = vec!["log", "--topo-order", FORMAT, skip.as_str(), n.as_str()];
            if self.fold.is_some() {
                args.push("--first-parent");
            }
            if self.path.is_some() {
                // Rewrites %P to the nearest commits that touch the path.
                args.push("--parents");
            }
            args.extend(self.revs.iter().map(String::as_str));
            args.push("--");
            args.extend(self.path.as_deref());
            let batch = parse_log(&git::text(&self.dir, &args)?);
            self.read += batch.len();
            if batch.len() < chunk || self.read >= MAX_ROWS {
                self.done = true;
            }
            for r in batch {
                if self.worktree_head.as_deref() == Some(r.id.as_str()) {
                    // Pin it above the trunk tip only; lower down a trunk line already runs through column 0.
                    let pinned = self.lanes.expects_trunk(&r.id) && self.lanes.trunk_lane_free();
                    let parents = vec![r.id.clone()];
                    let p = self.lanes.place(WORKTREE_ROW, &parents, pinned);
                    self.rows.push(worktree_row(parents, p));
                }
                self.push(r)?;
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct HistoryCache {
    streams: Mutex<Vec<(String, Arc<Mutex<Stream>>)>>,
}

pub struct Query<'a> {
    pub dir: &'a Path,
    pub trunk_tip: Option<&'a str>,
    /// Commit ids to show besides the trunk (the tab's HEAD, other branch tips).
    pub tips: Vec<String>,
    pub worktree_head: Option<&'a str>,
    /// Only this file's history (a repository-relative path).
    pub path: Option<&'a str>,
    /// Walk first parents only (ignored for a file's history).
    pub fold: bool,
    /// Folded merges to show expanded.
    pub expanded: Vec<String>,
    pub offset: usize,
    pub count: usize,
}

impl HistoryCache {
    pub fn page(&self, q: Query) -> Result<HistoryPage> {
        let mut revs: Vec<String> = q.trunk_tip.map(str::to_string).into_iter().collect();
        for t in q.tips {
            if !revs.contains(&t) {
                revs.push(t);
            }
        }
        let tips: Vec<String> = revs.iter().filter(|r| Some(r.as_str()) != q.trunk_tip).cloned().collect();
        if revs.is_empty() {
            return Ok(HistoryPage { rows: vec![], has_more: false, capped: false, tips });
        }
        let fold = (q.fold && q.path.is_none()).then(|| {
            let mut expanded = q.expanded.clone();
            expanded.sort();
            expanded.dedup();
            expanded
        });
        let fold_key = fold.as_ref().map_or_else(|| "-".to_string(), |e| e.join(" "));
        let key = format!("{}\0{}\0{}\0{}\0{}\0{fold_key}", q.dir.display(), q.trunk_tip.unwrap_or(""), revs.join(" "), q.worktree_head.unwrap_or(""), q.path.unwrap_or(""));
        let stream = {
            let mut streams = self.streams.lock().map_err(|_| anyhow::anyhow!("history cache poisoned"))?;
            match streams.iter().position(|(k, _)| *k == key) {
                Some(i) => {
                    let entry = streams.remove(i);
                    let s = entry.1.clone();
                    streams.push(entry);
                    s
                }
                None => {
                    let s = Arc::new(Mutex::new(match q.path {
                        None => {
                            let mut s = Stream::new(q.dir, q.trunk_tip, revs, None, q.worktree_head.map(str::to_string), false);
                            s.fold = fold.map(|e| Fold { expanded: e.into_iter().collect(), chains: None, placed: HashSet::new() });
                            s
                        }
                        Some(path) => {
                            // The trunk tip and the worktree's HEAD may not touch the file: lay out
                            // against the latest commits that do.
                            let spec = format!(":(literal){path}");
                            let trunk = q.trunk_tip.map(|t| last_touching(q.dir, t, &spec)).transpose()?.flatten();
                            let head = q.worktree_head.map(|h| last_touching(q.dir, h, &spec)).transpose()?.flatten();
                            let first = q.worktree_head.is_some() && head.is_none();
                            Stream::new(q.dir, trunk.as_deref(), revs, Some(spec), head, first)
                        }
                    }));
                    streams.push((key, s.clone()));
                    if streams.len() > CACHE_SIZE {
                        streams.remove(0);
                    }
                    s
                }
            }
        };
        let mut s = stream.lock().map_err(|_| anyhow::anyhow!("history stream poisoned"))?;
        let end = q.offset.saturating_add(q.count);
        s.fill(end)?;
        let from = q.offset.min(s.rows.len());
        let to = end.min(s.rows.len());
        Ok(HistoryPage {
            rows: s.rows[from..to].to_vec(),
            has_more: to < s.rows.len() || !s.done,
            capped: s.done && s.read >= MAX_ROWS && to >= s.rows.len(),
            tips,
        })
    }
}

/// The latest commit reachable from `rev` that changes the path: what `rev` becomes in the file's history.
fn last_touching(dir: &Path, rev: &str, spec: &str) -> Result<Option<String>> {
    let out = git::text(dir, &["log", "--topo-order", "--parents", "-1", "--format=%H", rev, "--", spec])?;
    Ok(out.split_whitespace().next().map(str::to_string))
}

/// Every local branch tip, plus remote ones when asked (for "show other branches").
pub fn branch_tips(dir: &Path, remotes: bool) -> Result<Vec<String>> {
    let mut args = vec!["for-each-ref", "--format=%(objectname) %(symref)", "refs/heads"];
    if remotes {
        args.push("refs/remotes");
    }
    let out = git::text(dir, &args)?;
    let mut tips: Vec<String> = out
        .lines()
        .filter(|l| l.split_once(' ').is_none_or(|(_, sym)| sym.is_empty()))
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect();
    tips.sort();
    tips.dedup();
    Ok(tips)
}

pub fn commit_detail(dir: &Path, hash: &str) -> Result<CommitDetail> {
    let out = git::text(dir, &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1f%b", hash, "--"])?;
    let f: Vec<&str> = out.splitn(9, '\x1f').collect();
    let get = |i: usize| f.get(i).copied().unwrap_or("").to_string();
    Ok(CommitDetail {
        hash: get(0),
        parents: get(1).split_whitespace().map(str::to_string).collect(),
        author: get(2),
        email: get(3),
        author_time: get(4).parse().unwrap_or(0),
        committer: get(5),
        commit_time: get(6).parse().unwrap_or(0),
        subject: get(7),
        body: get(8).trim_end().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records() {
        let text = "aaa\x1fbbb ccc\x1fJim\x1f100\x1fMerge x\x1e\nbbb\x1f\x1fJim\x1f90\x1finit\x1e\n";
        let rows = parse_log(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].parents, vec!["bbb", "ccc"]);
        assert!(rows[1].parents.is_empty());
        assert_eq!(rows[1].subject, "init");
    }
}
