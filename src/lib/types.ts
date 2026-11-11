// Mirrors src-tauri/src/core/model.rs (camelCase on the wire).

export interface Project {
  id: string
  name: string
  trunkOverride: string | null
  /** The group it's listed under; null, or an id no longer in the groups, means ungrouped. */
  group: string | null
  /** Listed first, above the groups; `group` is where it goes back when unpinned. */
  pinned: boolean
}

/** A folder in the projects list. */
export interface Group {
  id: string
  name: string
}

export interface ProjectSummary {
  id: string
  missing: boolean
  lastCommitAt: number | null
  linkedTrees: number
  dirtyTrees: number
  /** The repository on GitHub (from `origin`, else the first remote), when it has one. */
  webUrl: string | null
}

export interface Candidate {
  path: string
  name: string
  added: boolean
}

export interface AddResult {
  added: Project[]
  candidates: Candidate[]
}

export interface Worktree {
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

export interface Trunk {
  name: string
  tipRef: string
  tip: string
  localTip: string | null
  remoteRef: string | null
  remoteTip: string | null
  overridden: boolean
}

export interface BranchRef {
  name: string
  tip: string
  remote: boolean
}

export interface RefLabel {
  name: string
  kind: "branch" | "remote" | "tag"
}

export interface Overview {
  project: Project
  trunk: Trunk | null
  trees: Worktree[]
  branches: BranchRef[]
  refs: Record<string, RefLabel[]>
  hasRemote: boolean
  /** The repository on GitHub, for pull request links. */
  webUrl: string | null
}

export type Integration = "none" | "ancestor" | "squash"

export interface TrunkCompare {
  ahead: number
  behind: number
  integration: Integration
}

export interface TreeStatus {
  path: string
  head: string | null
  files: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null
  trunk: TrunkCompare | null
  error: string | null
  /** Its folder is gone: git only keeps a record of it, with the HEAD it had (compared in `trunk`). */
  missing: boolean
}

/** `[kind, from, to, color]`; kind 0 pass-through, 1 into the node, 2 out of the node, 3 cut-off edge. */
export type Segment = [number, number, number, number]

export interface HistoryRow {
  id: string
  parents: string[]
  author: string
  time: number
  subject: string
  col: number
  color: number
  segs: Segment[]
  /** Merges folded: a first-parent merge, true while what it merged is hidden, false once expanded. */
  folded?: boolean
}

export interface HistoryPage {
  rows: HistoryRow[]
  hasMore: boolean
  /** History continues, but rows stop at the backend cap. */
  capped: boolean
  /** Tips the history was built from; later pages pass them back. */
  tips: string[]
}

export interface CleanupCandidate {
  path: string
  branch: string | null
  head: string
  integration: Integration
  lastCommitAt: number | null
  /** Ignored files a build won't bring back (.env…): removing the tree deletes them. */
  notableIgnored: string[]
  /** HEAD, index or reflog changed in the last 15 minutes. */
  recent: boolean
  /** Its branch has a copy on origin (its upstream, or the same commit), as of the last fetch. */
  onOrigin: boolean
  /** Its folder is already gone: removing it drops git's record of it, nothing on disk. */
  missing: boolean
}

/** A local branch no worktree has checked out, judged against the trunk. */
export interface BranchStatus {
  name: string
  tip: string
  /** Commits the trunk doesn't have. */
  ahead: number
  integration: Integration
  lastCommitAt: number | null
  /** It tracked a remote branch that has since been deleted. */
  upstreamGone: boolean
  /** Created and never committed to. */
  neverCommitted: boolean
  /** Created or moved in the last 15 minutes. */
  recent: boolean
  /** A long-lived name (develop, release/*…): never offered for deletion. */
  protected: boolean
  /** The user chose to keep it. */
  kept: boolean
  /** It has a copy on origin (its upstream, or the same commit), as of the last fetch. */
  onOrigin: boolean
}

export interface RemoveOutcome {
  branchDeleted: boolean
  /** The branch actually deleted, read again at removal time. */
  deletedBranch: string | null
  branchKeptReason: string | null
  remote: RemoteDeletion
}

/** The branch's copy on origin. Both null: there was none, or deleting it wasn't asked for. */
export interface RemoteDeletion {
  /** `origin/<name>`, now deleted on origin. */
  deleted: string | null
  /** Why the copy on origin was kept. */
  keptReason: string | null
}

export interface PatchText {
  patch: string
  truncated: boolean
}

export interface CommitDetail {
  hash: string
  parents: string[]
  author: string
  email: string
  authorTime: number
  committer: string
  commitTime: number
  subject: string
  body: string
}

export type Target =
  | { kind: "commit"; hash: string }
  | { kind: "worktree"; tree: string }
  | { kind: "compare"; base: string; tip: string }

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted"

export interface FileChange {
  path: string
  oldPath: string | null
  status: ChangeStatus
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface Blob {
  text: string | null
  size: number
  binary: boolean
  tooLarge: boolean
}

export interface FilePair {
  old: Blob | null
  new: Blob | null
}

export interface Prefs {
  editor: string
  terminal: string
  fetchMinutes: number
  /** Empty: the system's default browser. */
  browser: string
}

export interface RepoChanged {
  id: string
  git: boolean
  trees: string[]
}

export const WORKTREE_ROW = "WORKTREE"

export interface FileList {
  paths: string[]
  truncated: boolean
}

/** One file for previewing: `text` for text (and SVG), `data` (base64) + `mime` for images. */
export interface FileContent {
  text: string | null
  data: string | null
  mime: string | null
  size: number
  binary: boolean
  tooLarge: boolean
}

/** A pull request on GitHub, as `gh` reports it. */
export interface PullRequest {
  number: number
  title: string
  author: string
  state: "open" | "merged" | "closed"
  isDraft: boolean
  headRefName: string
  headRefOid: string
  baseRefName: string
  /** The base tip GitHub compares with (for a merged PR: as it was before the merge). */
  baseRefOid: string
  /** From a fork: its branch isn't one of ours. */
  isCrossRepository: boolean
  headOwner: string | null
  reviewDecision: "approved" | "changesRequested" | "reviewRequired" | null
  mergeable: "mergeable" | "conflicting" | "unknown"
  additions: number
  deletions: number
  changedFiles: number
  checks: Check[]
  createdAt: number | null
  updatedAt: number | null
  mergedAt: number | null
  closedAt: number | null
  url: string
  /** Only when one pull request is read. */
  body: string | null
}

export type CheckState = "success" | "failure" | "pending" | "skipped" | "neutral" | "cancelled"

export interface Check {
  name: string
  workflow: string | null
  state: CheckState
  url: string | null
  startedAt: number | null
  completedAt: number | null
}

export interface PullRequests {
  /** `noGh`: gh isn't installed; `noAuth`: not logged in; `noGithub`: no GitHub remote. */
  state: "ok" | "noGh" | "noAuth" | "noGithub" | "error"
  message: string | null
  items: PullRequest[]
}

/** An image from a pull request, fetched by the backend (gh for GitHub's own, curl for the rest). */
export interface RemoteImage {
  mime: string
  /** Base64. */
  data: string
}

export type ReviewState = "approved" | "changesRequested" | "commented" | "dismissed"

/** A comment on the conversation, or a review's summary (its line comments are threads). */
export interface PrPost {
  kind: "comment" | "review"
  /** Reviews only: threads point to it with `reviewId`. */
  id: string | null
  author: string
  body: string
  state: ReviewState | null
  at: number | null
  url: string
}

export interface PrReply {
  author: string
  body: string
  at: number | null
  url: string
}

/** Comments on one place in the diff. */
export interface PrThread {
  path: string
  /** The line in the current diff; `null` once the code has changed (outdated). */
  line: number | null
  startLine: number | null
  originalLine: number | null
  /** On the old side of the diff: a removed line. */
  oldSide: boolean
  resolved: boolean
  outdated: boolean
  reviewId: string | null
  diffHunk: string
  comments: PrReply[]
}

export interface PrDiscussion {
  posts: PrPost[]
  threads: PrThread[]
  /** More than Retrace reads in one go (100 of each); the rest is on GitHub. */
  truncated: boolean
}

/** The pull request's commits are here; `ahead` of them on top of its base. */
export interface PreparedPr {
  ahead: number
}
