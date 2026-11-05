import { useCallback, useEffect, useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { inTauri, onAppFocused, onRepoChanged, watchProject } from "@/lib/api"
import { addPaths, closeDiff, run, selectProject } from "@/lib/commands"
import { keyNav } from "@/lib/keys"
import type { Node, PanelId } from "@/lib/layout"
import { installMenu } from "@/lib/menu"
import { prefs, ui, useStore } from "@/lib/store"
import { invalidateProject, useOverview } from "@/hooks/queries"
import { useDefaultSelection } from "@/hooks/use-project-view"
import { LayoutView } from "@/components/layout/LayoutView"
import { ProjectsPanel } from "@/components/app/ProjectsPanel"
import { GraphPanel } from "@/components/app/GraphPanel"
import { ChangesPanel } from "@/components/app/ChangesPanel"
import { DiffPanel } from "@/components/app/DiffPanel"
import { SettingsDialog } from "@/components/app/SettingsDialog"
import { AddProjectsDialog } from "@/components/app/AddProjectsDialog"

/** Focus mode: just the file list and the diff, side by side. */
const FOCUS_LAYOUT: Node = {
  type: "split",
  dir: "row",
  children: [
    { node: { type: "panel", id: "changes" }, size: 1 },
    { node: { type: "panel", id: "diff" }, size: 3.2 },
  ],
}
const NONE: PanelId[] = []

export default function App() {
  const qc = useQueryClient()
  const projectId = useStore(ui, (s) => s.projectId)
  const focusMode = useStore(ui, (s) => s.focusMode)
  const diffOpen = useStore(ui, (s) => s.diffOpen)
  const settingsOpen = useStore(ui, (s) => s.settingsOpen)
  const adding = useStore(ui, (s) => s.adding)
  const collapsed = useStore(prefs, (s) => s.projectsCollapsed)
  const layout = useStore(prefs, (s) => s.layout)
  useDefaultSelection()

  useEffect(() => {
    let off: (() => void) | undefined
    let cancelled = false
    installMenu()
      .then((f) => (cancelled ? f() : (off = f)))
      .catch((e) => console.error("menu", e))
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  // Watch the selected project (again whenever its worktrees change); refresh on file-system and fetch events.
  const overview = useOverview(projectId)
  const treesKey = overview.data?.trees.map((t) => t.path).join("\n") ?? ""
  useEffect(() => {
    watchProject(projectId).catch(() => {})
  }, [projectId, treesKey])
  useEffect(() => {
    const offs: Promise<() => void>[] = [
      onRepoChanged((e) => invalidateProject(qc, e.id, e)),
      onAppFocused(() => {
        const id = ui.get().projectId
        if (id) invalidateProject(qc, id, { git: true, trees: [] })
        // Other projects' dots: only the ones older than their stale time.
        qc.refetchQueries({ queryKey: ["summary"], stale: true, type: "active" })
      }),
    ]
    return () => offs.forEach((p) => p.then((off) => off()))
  }, [qc])
  // The browser dev bridge has no file events: poll the open project instead.
  useEffect(() => {
    if (inTauri || !projectId) return
    const t = setInterval(() => invalidateProject(qc, projectId, { git: true, trees: [] }), 10_000)
    return () => clearInterval(t)
  }, [qc, projectId])

  useEffect(() => {
    // ⌘ shortcuts also sit in the native menu; `run` drops the second of the two calls.
    const MOD: Record<string, Parameters<typeof run>[0]> = {
      "\\": "toggleProjects",
      f: "find",
      r: "refresh",
      ",": "settings",
      j: "toggleDiff",
      o: "addProject",
    }
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")
      const s = ui.get()
      if (e.key === "Escape") {
        if (typing) return (e.target as HTMLElement).blur()
        if (document.querySelector("[role=dialog], [data-radix-popper-content-wrapper]")) return
        if (s.focusMode) return ui.set({ focusMode: false })
        if (s.diffOpen) return closeDiff()
        if (s.query) return ui.set({ query: "" })
        return
      }
      if (typing || document.querySelector("[role=dialog]")) return
      const mod = e.metaKey || e.ctrlKey
      const command = mod && !e.shiftKey && !e.altKey ? MOD[e.key.toLowerCase()] : undefined
      if (command) {
        e.preventDefault()
        return run(command)
      }
      if (mod || e.altKey) return
      if (e.key.toLowerCase() === "f") return run("toggleFocus")
      const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0
      if (dir) {
        e.preventDefault()
        return s.focusArea === "changes" || s.focusMode ? keyNav.changes?.(dir) : keyNav.graph?.(dir)
      }
      if ((e.key === "ArrowRight" || e.key === "Enter") && s.focusArea === "graph") {
        e.preventDefault()
        // Open the diff even when the list isn't there (an empty commit, still loading); the list then picks a file.
        ui.set({ diffOpen: true, focusArea: "changes" })
        return keyNav.enterChanges?.()
      }
      if (e.key === "ArrowLeft" && s.focusArea === "changes") {
        e.preventDefault()
        return ui.set({ focusArea: "graph" })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const render = useCallback((id: PanelId) => {
    switch (id) {
      case "projects":
        return <ProjectsPanel />
      case "graph":
        return <GraphPanel />
      case "changes":
        return <ChangesPanel />
      case "diff":
        return <DiffPanel />
    }
  }, [])
  // The diff closes like any hidden view: it keeps its place in the layout and gives up its space.
  const hidden = useMemo(() => [...(collapsed ? (["projects"] as const) : []), ...(diffOpen ? [] : (["diff"] as const))], [collapsed, diffOpen])

  return (
    <div className="h-full overflow-hidden">
      {focusMode ? <LayoutView layout={FOCUS_LAYOUT} hidden={NONE} editable={false} render={render} /> : <LayoutView layout={layout} hidden={hidden} render={render} />}
      <SettingsDialog open={settingsOpen} onOpenChange={(o) => ui.set({ settingsOpen: o })} />
      {adding && <AddProjectsDialog state={adding} onClose={() => ui.set({ adding: null })} onAddPaths={addPaths} onAdded={selectProject} />}
    </div>
  )
}
