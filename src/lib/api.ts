// One door to the Rust core. Inside the app: Tauri `invoke("api")`. In a plain browser
// (`pnpm dev` + `cargo run --bin retrace-devbridge`): the same commands over HTTP.

import type {
  AddResult,
  BranchStatus,
  CleanupCandidate,
  PatchText,
  RemoveOutcome,
  RemoteDeletion,
  CommitDetail,
  FileChange,
  FileContent,
  FileList,
  FilePair,
  Group,
  HistoryPage,
  Overview,
  Prefs,
  PreparedPr,
  Project,
  ProjectSummary,
  PullRequest,
  PullRequests,
  RepoChanged,
  Target,
  TreeStatus,
  TrunkCompare,
} from "./types"
import { t } from "./i18n"

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core")
    // The command rejects with the message string; make it an Error so views can show it.
    return invoke<T>("api", { cmd, args }).catch((e: unknown) => {
      throw e instanceof Error ? e : new Error(String(e))
    })
  }
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Retrace": "1" },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(t("The dev bridge isn't responding (cargo run --bin retrace-devbridge)"))
  const body = (await res.json()) as { ok?: T; error?: string }
  if (body.error) throw new Error(body.error)
  return body.ok as T
}

export const api = {
  listProjects: () => call<Project[]>("listProjects"),
  projectSummary: (id: string) => call<ProjectSummary>("projectSummary", { id }),
  addPath: (path: string) => call<AddResult>("addPath", { path }),
  addProjects: (paths: string[]) => call<Project[]>("addProjects", { paths }),
  removeProject: (id: string) => call<null>("removeProject", { id }),
  listGroups: () => call<Group[]>("listGroups"),
  /** `index`: position among the groups (the end when absent). */
  createGroup: (name: string, projects: string[] = [], index?: number) => call<Group>("createGroup", { name, projects, index }),
  renameGroup: (id: string, name: string) => call<null>("renameGroup", { id, name }),
  /** Its projects stay in the list, ungrouped. */
  deleteGroup: (id: string) => call<null>("deleteGroup", { id }),
  reorderGroups: (ids: string[]) => call<null>("reorderGroups", { ids }),
  setProjectGroup: (ids: string[], group: string | null) => call<null>("setProjectGroup", { ids, group }),
  setProjectPinned: (ids: string[], pinned: boolean) => call<null>("setProjectPinned", { ids, pinned }),
  setTrunk: (id: string, branch: string | null) => call<null>("setTrunk", { id, branch }),
  overview: (id: string) => call<Overview>("overview", { id }),
  treeStatuses: (id: string) => call<TreeStatus[]>("treeStatuses", { id }),
  compare: (id: string, tip: string) => call<TrunkCompare>("compare", { id, tip }),
  history: (a: {
    id: string
    trunkTip: string | null
    tip: string | null
    worktreeHead: string | null
    allBranches: boolean
    remotes: boolean
    offset: number
    count: number
    tips?: string[]
    /** Only this file's history. */
    path?: string | null
  }) => call<HistoryPage>("history", a),
  /** `moved`: a project dragged into or out of a group or the pinned ones, saved with the new order. */
  reorderProjects: (ids: string[], moved?: { id: string; group: string | null; pinned?: boolean }) => call<null>("reorderProjects", { ids, moved }),
  patch: (id: string, target: Target) => call<PatchText>("patch", { id, target }),
  cleanupCandidates: (id: string) => call<CleanupCandidate[]>("cleanupCandidates", { id }),
  /** `acknowledgedIgnored`: irreplaceable ignored files shown when confirming; a new one stops the removal. */
  /** `deleteRemote`: also delete the deleted branch's copy on origin. */
  removeWorktree: (id: string, path: string, head: string, acknowledgedIgnored: string[], deleteBranch: boolean, deleteRemote: boolean) =>
    call<RemoveOutcome>("removeWorktree", { id, path, head, acknowledgedIgnored, deleteBranch, deleteRemote }),
  branchStatuses: (id: string) => call<BranchStatus[]>("branchStatuses", { id }),
  /** Deleted only while the branch still points at `tip`, after every check runs again. */
  deleteBranch: (id: string, name: string, tip: string, deleteRemote: boolean) => call<RemoteDeletion>("deleteBranch", { id, name, tip, deleteRemote }),
  /** Undo: brings back a branch deleted in this session, at the same commit. */
  restoreBranch: (id: string, name: string) => call<{ settingsFailed: string[] }>("restoreBranch", { id, name }),
  keepBranch: (id: string, name: string, keep: boolean) => call<null>("keepBranch", { id, name, keep }),
  commit: (id: string, hash: string) => call<CommitDetail>("commit", { id, hash }),
  changes: (id: string, target: Target) => call<FileChange[]>("changes", { id, target }),
  filePair: (id: string, target: Target, path: string, oldPath: string | null) =>
    call<FilePair>("filePair", { id, target, path, oldPath }),
  files: (id: string, target: Target) => call<FileList>("files", { id, target }),
  /** `old`: the version the target is compared with (parent, HEAD, merge base). `null` when the file isn't there. */
  fileContent: (id: string, target: Target, path: string, side: "new" | "old", oldPath?: string | null) =>
    call<FileContent | null>("fileContent", { id, target, path, side, oldPath: oldPath ?? null }),
  /** Open pull requests through the user's `gh`; the state says when it isn't available. */
  pullRequests: (id: string) => call<PullRequests>("pullRequests", { id }),
  /** One pull request, with its description. */
  pullRequest: (id: string, number: number) => call<PullRequest>("pullRequest", { id, number }),
  /** Fetches the pull request's commits (objects only) when they aren't here yet. */
  preparePr: (id: string, pr: PullRequest) =>
    call<PreparedPr>("preparePr", { id, number: pr.number, head: pr.headRefOid, base: pr.baseRefOid, baseRef: pr.baseRefName }),
  openUrl: (url: string) => call<null>("openUrl", { url }),
  /** Language of error messages from the backend. */
  setLanguage: (lang: "zh" | "en") => call<null>("setLanguage", { lang }),
  fetch: (id: string) => call<null>("fetch", { id }),
  getPrefs: () => call<Prefs>("getPrefs"),
  setPrefs: (prefs: Prefs) => call<null>("setPrefs", prefs as unknown as Record<string, unknown>),
  open: (id: string, path: string, how: "finder" | "terminal" | "editor") => call<null>("open", { id, path, with: how }),
}

/** Start watching one project (or stop with null). No-op in the browser. */
export async function watchProject(id: string | null) {
  if (!inTauri) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("watch_project", { id })
}

export async function onRepoChanged(cb: (e: RepoChanged) => void): Promise<() => void> {
  if (!inTauri) return () => {}
  const { listen } = await import("@tauri-apps/api/event")
  return listen<RepoChanged>("repo-changed", (e) => cb(e.payload))
}

export async function onAppFocused(cb: () => void): Promise<() => void> {
  if (inTauri) {
    const { listen } = await import("@tauri-apps/api/event")
    return listen("app-focused", () => cb())
  }
  window.addEventListener("focus", cb)
  return () => window.removeEventListener("focus", cb)
}

/** Native folder picker. `null` in the browser, where the caller asks for a typed path instead. */
export async function pickFolders(): Promise<string[] | null> {
  if (!inTauri) return null
  const { open } = await import("@tauri-apps/plugin-dialog")
  const picked = await open({ directory: true, multiple: true, title: t("Add project") })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}
