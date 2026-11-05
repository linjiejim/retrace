//! Wire types shared with the frontend (`src/lib/types.ts`). Field names are camelCase on the wire.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Absolute path of the main worktree (or the bare repository); also the id.
    pub id: String,
    pub name: String,
    pub trunk_override: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub missing: bool,
    pub last_commit_at: Option<i64>,
    pub linked_trees: usize,
    pub dirty_trees: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub name: String,
    pub added: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub added: Vec<Project>,
    /// The chosen folder isn't a repository: these are the repositories inside it.
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trunk {
    /// Branch name as the user knows it, e.g. `main`.
    pub name: String,
    /// The ref whose commit is used as the tip, e.g. `main` or `origin/main`.
    pub tip_ref: String,
    pub tip: String,
    pub local_tip: Option<String>,
    pub remote_ref: Option<String>,
    pub remote_tip: Option<String>,
    pub overridden: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    pub name: String,
    pub tip: String,
    pub remote: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    /// `branch` | `remote` | `tag`
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub project: Project,
    pub trunk: Option<Trunk>,
    pub trees: Vec<Worktree>,
    pub branches: Vec<BranchRef>,
    pub refs: HashMap<String, Vec<RefLabel>>,
    pub has_remote: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Integration {
    None,
    /// The branch tip is reachable from the trunk (fast-forward, merge commit, ff-only land).
    Ancestor,
    /// Merging the branch into the trunk changes nothing (squash or rebase merge).
    Squash,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrunkCompare {
    pub ahead: u32,
    pub behind: u32,
    pub integration: Integration,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeStatus {
    pub path: String,
    pub head: Option<String>,
    pub files: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    /// `merge` | `rebase` | `cherry-pick` | `revert` | `bisect`
    pub operation: Option<&'static str>,
    pub trunk: Option<TrunkCompare>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub subject: String,
    pub col: u16,
    pub color: u8,
    /// `[kind, from, to, color]`, kind: 0 pass-through, 1 into the node, 2 out of the node, 3 cut-off edge.
    pub segs: Vec<[u16; 4]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub rows: Vec<HistoryRow>,
    pub has_more: bool,
    /// History goes on but rows stop at `history::MAX_ROWS`.
    pub capped: bool,
    /// The tips this history was built from: later pages pass them back so that branches moving in
    /// between can't mix two different histories.
    pub tips: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Commit { hash: String },
    /// Uncommitted changes of one worktree, against its HEAD.
    Worktree { tree: String },
    /// Everything `tip` adds on top of its merge base with `base`.
    Compare { base: String, tip: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    /// `added` | `modified` | `deleted` | `renamed` | `copied` | `typechange` | `untracked` | `conflicted`
    pub status: &'static str,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
    /// File mode changed (e.g. chmod +x). Internal: tells a real change from a stat-only one.
    #[serde(skip)]
    pub mode_changed: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Blob {
    pub text: Option<String>,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub integration: Integration,
    pub last_commit_at: Option<i64>,
    /// Ignored files that a build won't bring back (`.env`…); removing the tree deletes them.
    pub notable_ignored: Vec<String>,
    /// HEAD, index or reflog changed in the last 15 minutes.
    pub recent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub branch_deleted: bool,
    pub branch_kept_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchText {
    pub patch: String,
    /// Cut at a file boundary because the whole patch was too large.
    pub truncated: bool,
}

/// Every file in one version, sorted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// One file for previewing: `text` for text (and SVG), `data` (base64) + `mime` for images.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: Option<String>,
    pub data: Option<String>,
    pub mime: Option<String>,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePair {
    /// `None` when the file doesn't exist on that side.
    pub old: Option<Blob>,
    pub new: Option<Blob>,
}
