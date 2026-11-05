//! Commit history for one tab, laid out as a graph and served in pages.
//!
//! A `Stream` per (repository, tips, uncommitted row) keeps the rows read so far and the lane state,
//! so the next page only reads and lays out new rows. Tips are commit ids, so a moved branch is a
//! new key and stale streams simply age out of the small cache.

use super::git;
use super::graph::Lanes;
use super::model::*;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const WORKTREE_ROW: &str = "WORKTREE";
/// Rows beyond this are not shown (the page says so).
pub const MAX_ROWS: usize = 100_000;
const CACHE_SIZE: usize = 8;

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

struct Stream {
    dir: PathBuf,
    revs: Vec<String>,
    worktree_head: Option<String>,
    /// Commits read from git so far (the uncommitted row is not counted).
    read: usize,
    done: bool,
    rows: Vec<HistoryRow>,
    lanes: Lanes,
}

impl Stream {
    fn new(dir: &Path, trunk_tip: Option<&str>, revs: Vec<String>, worktree_head: Option<String>) -> Self {
        Self { dir: dir.to_path_buf(), revs, worktree_head, read: 0, done: false, rows: Vec::new(), lanes: Lanes::new(trunk_tip) }
    }

    /// Read and lay out commits until at least `want` rows exist or history ends.
    fn fill(&mut self, want: usize) -> Result<()> {
        while !self.done && self.rows.len() < want {
            // The topological walk costs about the same for 1k or 10k rows, so read generously.
            let chunk = (want - self.rows.len()).max(self.read).clamp(1000, 20_000);
            let skip = format!("--skip={}", self.read);
            let n = format!("-n{chunk}");
            let mut args = vec!["log", "--topo-order", "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e", skip.as_str(), n.as_str()];
            args.extend(self.revs.iter().map(String::as_str));
            args.push("--");
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
                    self.rows.push(HistoryRow { id: WORKTREE_ROW.into(), parents, author: String::new(), time: 0, subject: String::new(), col: p.col, color: p.color, segs: p.segs });
                }
                let p = self.lanes.place(&r.id, &r.parents, false);
                self.rows.push(HistoryRow { id: r.id, parents: r.parents, author: r.author, time: r.time, subject: r.subject, col: p.col, color: p.color, segs: p.segs });
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
        let key = format!("{}\0{}\0{}\0{}", q.dir.display(), q.trunk_tip.unwrap_or(""), revs.join(" "), q.worktree_head.unwrap_or(""));
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
                    let s = Arc::new(Mutex::new(Stream::new(q.dir, q.trunk_tip, revs, q.worktree_head.map(str::to_string))));
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
