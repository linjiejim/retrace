// One door to the Rust core. Inside the app: Tauri `invoke("api")`. In a plain browser
// (`pnpm dev` + `cargo run --bin retrace-devbridge`): the same commands over HTTP.

import type {
  AddResult,
  CleanupCandidate,
  PatchText,
  RemoveOutcome,
  CommitDetail,
  FileChange,
  FileContent,
  FileList,
  FilePair,
  HistoryPage,
  Overview,
  Prefs,
  Project,
  ProjectSummary,
  RepoChanged,
  Target,
  TreeStatus,
  TrunkCompare,
} from "./types"

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
  if (!res.ok) throw new Error("开发桥没有响应（cargo run --bin retrace-devbridge）")
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
  }) => call<HistoryPage>("history", a),
  reorderProjects: (ids: string[]) => call<null>("reorderProjects", { ids }),
  patch: (id: string, target: Target) => call<PatchText>("patch", { id, target }),
  cleanupCandidates: (id: string) => call<CleanupCandidate[]>("cleanupCandidates", { id }),
  /** `acknowledgedIgnored`: irreplaceable ignored files shown when confirming; a new one stops the removal. */
  removeWorktree: (id: string, path: string, head: string, acknowledgedIgnored: string[], deleteBranch: boolean) =>
    call<RemoveOutcome>("removeWorktree", { id, path, head, acknowledgedIgnored, deleteBranch }),
  commit: (id: string, hash: string) => call<CommitDetail>("commit", { id, hash }),
  changes: (id: string, target: Target) => call<FileChange[]>("changes", { id, target }),
  filePair: (id: string, target: Target, path: string, oldPath: string | null) =>
    call<FilePair>("filePair", { id, target, path, oldPath }),
  files: (id: string, target: Target) => call<FileList>("files", { id, target }),
  /** `old`: the version the target is compared with (parent, HEAD, merge base). `null` when the file isn't there. */
  fileContent: (id: string, target: Target, path: string, side: "new" | "old", oldPath?: string | null) =>
    call<FileContent | null>("fileContent", { id, target, path, side, oldPath: oldPath ?? null }),
  openUrl: (url: string) => call<null>("openUrl", { url }),
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
  const picked = await open({ directory: true, multiple: true, title: "添加项目" })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}
