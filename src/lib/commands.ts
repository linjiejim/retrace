// Actions shared by the native menu, keyboard shortcuts and buttons. They work on the stores
// directly, so they run whether or not the view that shows the result is on screen.

import { api, pickFolders } from "./api"
import { keyNav } from "./keys"
import { t } from "./i18n"
import { DEFAULT_LAYOUT } from "./layout"
import { queryClient } from "./query"
import { prefs, selectionKey, ui, type Selection } from "./store"
import type { Overview, Project } from "./types"
import { checkForUpdates } from "./updater"
import { invalidateProject, summaryQuery } from "@/hooks/queries"
import { notify } from "@/components/ui/toast"

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function selectProject(id: string) {
  ui.set({ projectId: id, selection: null, file: null, preview: null, historyFile: null, query: "", focusMode: false, diffOpen: false })
}

/** A graph row was clicked: select it and show its diff; clicking the selected row shows or hides the diff. */
export function pickRow(sel: Selection) {
  const s = ui.get()
  if (selectionKey(s.selection) === selectionKey(sel)) {
    return ui.set({ diffOpen: !s.diffOpen, focusMode: s.diffOpen ? false : s.focusMode, focusArea: "graph" })
  }
  ui.set({ selection: sel, diffOpen: true, focusArea: "graph" })
}

export function openFile(file: { path: string; oldPath: string | null }) {
  ui.set({ file, focusArea: "changes", jump: Date.now(), diffOpen: true })
}

/** A file picked in the files view: preview it, and narrow the graph to its history. */
export function openPreview(path: string) {
  ui.set({ preview: path, historyFile: path, focusArea: "changes", diffOpen: true })
}

/** Narrow the graph to one file's commits, or (null) back to all of them. */
export function showFileHistory(path: string | null) {
  ui.set({ historyFile: path })
}

/** A web link, in the browser chosen in settings (the system default unless set). */
export function openLink(url: string) {
  api.openUrl(url).catch((e) => notify.error(message(e)))
}

export function closeDiff() {
  ui.set({ diffOpen: false, focusMode: false })
}

/** The worktree the current tab shows; branch tabs use the main worktree. */
function currentTreePath(): string | null {
  const { projectId, tabs } = ui.get()
  if (!projectId) return null
  const ov = queryClient.getQueryData<Overview>(["overview", projectId])
  const key = tabs[projectId] ?? ""
  if (key.startsWith("tree:") && ov?.trees.some((t) => t.path === key.slice(5))) return key.slice(5)
  return ov?.trees.find((t) => t.isMain)?.path ?? projectId
}

function openCurrent(how: "finder" | "terminal" | "editor") {
  const { projectId } = ui.get()
  const path = currentTreePath()
  if (!projectId || !path) return notify.info(t("Pick a project first"))
  api.open(projectId, path, how).catch((e) => notify.error(message(e)))
}

/** The current project's repository on GitHub. */
async function openOnGitHub() {
  const { projectId } = ui.get()
  if (!projectId) return notify.info(t("Pick a project first"))
  try {
    // Cached data will do, even stale: refetching runs `git status` in every worktree first.
    const { webUrl } = await queryClient.query({ ...summaryQuery(projectId), staleTime: "static" })
    if (!webUrl) return notify.info(t("This project has no GitHub remote"))
    openLink(webUrl)
  } catch (e) {
    notify.error(message(e))
  }
}

export async function addPaths(paths: string[]) {
  const added: Project[] = []
  const candidates = []
  for (const p of paths) {
    try {
      const r = await api.addPath(p)
      added.push(...r.added)
      candidates.push(...r.candidates)
    } catch (e) {
      notify.error(message(e))
    }
  }
  await queryClient.invalidateQueries({ queryKey: ["projects"] })
  if (added[0]) selectProject(added[0].id)
  ui.set({ adding: candidates.length ? { step: "pick", candidates } : null })
}

async function addProject() {
  const picked = await pickFolders()
  if (picked === null) return ui.set({ adding: { step: "path" } })
  if (picked.length) await addPaths(picked)
}

async function refresh() {
  const id = ui.get().projectId
  if (!id) return
  invalidateProject(queryClient, id, { git: true, trees: [] })
  const ov = queryClient.getQueryData<Overview>(["overview", id])
  if (!ov?.hasRemote || ui.get().fetching) return
  ui.set({ fetching: true })
  try {
    await api.fetch(id)
    invalidateProject(queryClient, id, { git: true, trees: [] })
  } catch (e) {
    notify.error(t("Couldn't fetch from the remote: {reason}", { reason: message(e) }))
  } finally {
    ui.set({ fetching: false })
  }
}

export const commands = {
  settings: () => ui.set({ settingsOpen: true }),
  checkForUpdates: () => void checkForUpdates(true),
  addProject: () => void addProject(),
  refresh: () => void refresh(),
  revealInFinder: () => openCurrent("finder"),
  openInTerminal: () => openCurrent("terminal"),
  openInEditor: () => openCurrent("editor"),
  openOnGitHub: () => void openOnGitHub(),
  find: () => keyNav.focusSearch?.(),
  toggleProjects: () => prefs.set((p) => ({ projectsCollapsed: !p.projectsCollapsed })),
  toggleDiff: () => (ui.get().diffOpen ? closeDiff() : ui.set({ diffOpen: true })),
  toggleFocus: () => {
    const s = ui.get()
    if (s.selection) ui.set({ focusMode: !s.focusMode, diffOpen: true })
  },
  toggleSplit: () => prefs.set((p) => ({ diffStyle: p.diffStyle === "split" ? "unified" : "split" })),
  toggleWrap: () => prefs.set((p) => ({ wrap: !p.wrap })),
  toggleContinuous: () => prefs.set((p) => ({ diffView: p.diffView === "all" ? "file" : "all" })),
  toggleOtherBranches: () => prefs.set((p) => ({ otherBranches: !p.otherBranches })),
  toggleRemotes: () => prefs.set((p) => ({ otherBranches: true, remoteBranches: !p.remoteBranches })),
  /** Back to the first-run view: the sketch layout, projects shown, diff closed. */
  resetLayout: () => {
    prefs.set({ layout: DEFAULT_LAYOUT, projectsCollapsed: false })
    closeDiff()
  },
}

export type CommandId = keyof typeof commands

const lastRun = new Map<CommandId, number>()

/** Run a command. The page and the native menu can both see one shortcut; the second call is dropped. */
export function run(id: CommandId) {
  const now = performance.now()
  if (now - (lastRun.get(id) ?? -Infinity) < 150) return
  lastRun.set(id, now)
  commands[id]()
}
