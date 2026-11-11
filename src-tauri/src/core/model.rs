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
    pub group: Option<String>,
    /// Listed first, above the groups.
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub missing: bool,
    pub last_commit_at: Option<i64>,
    pub linked_trees: usize,
    pub dirty_trees: usize,
    /// The repository on GitHub (from `origin`, else the first remote), for "Open on GitHub".
    pub web_url: Option<String>,
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
    /// The repository on GitHub (`https://github.com/owner/repo`), for pull request links.
    pub web_url: Option<String>,
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
    /// Its folder is gone: git only keeps a record of it, with the HEAD it had (compared in `trunk`).
    pub missing: bool,
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
    /// With merges folded, a merge on a first-parent chain: true while what it merged is hidden,
    /// false once expanded. Absent on every other row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folded: Option<bool>,
    /// With other branches folded, the tip of one of them. Absent on every other row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<BranchFold>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFold {
    /// Its own commits are hidden and this row stands for them (false once opened).
    pub folded: bool,
    /// Its own commits: neither the trunk nor the tab's HEAD has them (nor, while folded, an opened branch).
    pub commits: u32,
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
    /// Its branch has a copy on origin, as of the last fetch (see `cleanup::origin_copy`).
    pub on_origin: bool,
    /// Its folder is already gone: removing it drops git's record of it, nothing on disk.
    pub missing: bool,
}

/// A local branch no worktree has checked out, judged against the trunk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub name: String,
    pub tip: String,
    /// Commits the trunk doesn't have.
    pub ahead: u32,
    pub integration: Integration,
    pub last_commit_at: Option<i64>,
    /// It tracked a remote branch that has since been deleted (`[gone]`).
    pub upstream_gone: bool,
    /// Its reflog only records its creation: it never had commits of its own.
    pub never_committed: bool,
    /// Created or moved in the last 15 minutes.
    pub recent: bool,
    /// A long-lived name (`develop`, `release/*`…): never offered for deletion.
    pub protected: bool,
    /// The user chose to keep it.
    pub kept: bool,
    /// It has a copy on origin, as of the last fetch (see `cleanup::origin_copy`).
    pub on_origin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub branch_deleted: bool,
    /// The branch actually deleted, read again at removal time (it may have been renamed).
    pub deleted_branch: Option<String>,
    pub branch_kept_reason: Option<String>,
    /// What Undo needs to bring the deleted branch back; stays in the backend.
    #[serde(skip)]
    pub deleted: Option<DeletedBranch>,
    /// What happened to the branch's copy on origin, when asked to delete it too.
    pub remote: RemoteDeletion,
}

/// The branch's copy on origin, deleted along with the local branch or kept. Both empty: there was
/// none, or deleting it wasn't asked for.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeletion {
    /// `origin/<name>`, now deleted on origin.
    pub deleted: Option<String>,
    /// Why the copy on origin was kept.
    pub kept_reason: Option<String>,
}

/// A branch this app deleted: its tip and its `branch.<name>.*` settings, for Undo.
#[derive(Debug, Clone, PartialEq)]
pub struct DeletedBranch {
    pub name: String,
    pub tip: String,
    pub config: Vec<(String, Option<String>)>,
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

/// A pull request on GitHub, as `gh` reports it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub author: String,
    /// `open` | `merged` | `closed`
    pub state: &'static str,
    pub is_draft: bool,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    pub base_ref_name: String,
    /// The base branch's tip GitHub compares with (for a merged PR: as it was before the merge).
    pub base_ref_oid: String,
    /// From a fork: its branch isn't one of ours.
    pub is_cross_repository: bool,
    pub head_owner: Option<String>,
    /// `approved` | `changesRequested` | `reviewRequired`
    pub review_decision: Option<&'static str>,
    /// `mergeable` | `conflicting` | `unknown`
    pub mergeable: &'static str,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub checks: Vec<Check>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub merged_at: Option<i64>,
    pub closed_at: Option<i64>,
    pub url: String,
    /// Only when one pull request is read.
    pub body: Option<String>,
}

/// One CI check of a pull request's head commit (a check run or a commit status).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub workflow: Option<String>,
    /// `success` | `failure` | `pending` | `skipped` | `neutral` | `cancelled`
    pub state: &'static str,
    pub url: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequests {
    /// `ok` | `noGh` (not installed) | `noAuth` (not logged in) | `noGithub` | `error`
    pub state: &'static str,
    pub message: Option<String>,
    pub items: Vec<PullRequest>,
}

/// A pull request's commits are in the repository; `ahead` of them on top of its base.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPr {
    pub ahead: u32,
}

/// An image from a pull request's description or discussion, fetched by the backend.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RemoteImage {
    pub mime: &'static str,
    /// Base64.
    pub data: String,
}

/// A pull request's conversation: comments and reviews in time order, and the review threads on lines.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrDiscussion {
    pub posts: Vec<PrPost>,
    pub threads: Vec<PrThread>,
    /// GitHub had more than Retrace reads in one go (100 of each); the rest is on GitHub.
    pub truncated: bool,
}

/// A comment on the conversation, or a review (its summary; its line comments are threads).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrPost {
    /// "comment" | "review"
    pub kind: &'static str,
    /// Reviews only: GitHub's node id, which threads point to.
    pub id: Option<String>,
    pub author: String,
    pub body: String,
    /// Reviews only: "approved" | "changesRequested" | "commented" | "dismissed"
    pub state: Option<&'static str>,
    pub at: Option<i64>,
    pub url: String,
}

/// Comments on one place in the diff.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrThread {
    pub path: String,
    /// The line in the current diff; `None` when the code it was on has changed (outdated).
    pub line: Option<u32>,
    pub start_line: Option<u32>,
    pub original_line: Option<u32>,
    /// The old side of the diff ("LEFT"): a removed line.
    pub old_side: bool,
    pub resolved: bool,
    pub outdated: bool,
    /// The review the first comment was posted in.
    pub review_id: Option<String>,
    /// The diff around the first comment, ending at its line.
    pub diff_hunk: String,
    pub comments: Vec<PrReply>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrReply {
    pub author: String,
    pub body: String,
    pub at: Option<i64>,
    pub url: String,
}
