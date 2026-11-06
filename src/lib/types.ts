// Mirrors src-tauri/src/core/model.rs (camelCase on the wire).

export interface Project {
  id: string
  name: string
  trunkOverride: string | null
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
}

export interface RemoveOutcome {
  branchDeleted: boolean
  /** The branch actually deleted, read again at removal time. */
  deletedBranch: string | null
  branchKeptReason: string | null
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
