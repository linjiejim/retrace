import { useEffect, useMemo, useRef } from "react"
import { buildTabs, compareOf, useCompare, useOverview, useStatuses, type Tab } from "./queries"
import { ui, useStore, type Selection } from "@/lib/store"
import type { Target, Trunk } from "@/lib/types"
import { inTauri } from "@/lib/api"

const NONE: string[] = []

/** Everything the history and detail panes derive from the selected project and tab. */
export function useProjectView() {
  const projectId = useStore(ui, (s) => s.projectId)
  const tabKey = useStore(ui, (s) => (projectId ? s.tabs[projectId] : undefined))
  const branchTabs = useStore(ui, (s) => (projectId ? s.branchTabs[projectId] : undefined)) ?? NONE
  const overview = useOverview(projectId)
  const statuses = useStatuses(projectId)
  const tabs = useMemo(() => buildTabs(overview.data, statuses.data, branchTabs), [overview.data, statuses.data, branchTabs])
  const tab: Tab | undefined = tabs.find((t) => t.key === tabKey) ?? tabs.find((t) => t.tree?.isMain) ?? tabs[0]
  const trunk = overview.data?.trunk ?? null
  const branchCompare = useCompare(projectId, tab?.head ?? null, tab?.kind === "branch" && !!trunk && tab.head !== trunk.tip)
  const compare = compareOf(tab, branchCompare.data)
  const dirtyFiles = tab?.kind === "tree" ? (tab.status?.files ?? 0) : 0
  /** "Everything this branch adds" makes sense only when the tab is not the trunk itself. */
  const showCompare = !!trunk && !!tab?.head && tab.head !== trunk.tip && (compare?.ahead ?? 0) > 0
  return { projectId, overview, statuses, tabs, tab, trunk, compare, dirtyFiles, showCompare, inTauri }
}

export function targetOf(sel: Selection | null, tab: Tab | undefined, trunk: Trunk | null): Target | null {
  if (!tab) return null
  // With no graph row selected, browse the current worktree's uncommitted changes and files.
  if (!sel) return tab.tree ? { kind: "worktree", tree: tab.tree.path } : null
  if (sel.kind === "commit") return { kind: "commit", hash: sel.hash }
  if (sel.kind === "worktree") return tab.tree ? { kind: "worktree", tree: tab.tree.path } : null
  return trunk && tab.head ? { kind: "compare", base: trunk.tip, tip: tab.head } : null
}

/**
 * Default selection for a tab: uncommitted work if any, else the tab's HEAD. Lives at the app level
 * because any view can be hidden or moved. Worktree tabs wait for their own status entry.
 */
export function useDefaultSelection() {
  const { projectId, tab, statuses, dirtyFiles, showCompare } = useProjectView()
  const selection = useStore(ui, (s) => s.selection)
  const statusReady = tab?.kind !== "tree" || (!!tab.status && !statuses.isPlaceholderData)
  // The tab the selection belongs to. If the shown tab changes without the user picking it (an
  // archived worktree was removed, a branch disappeared), the old selection belongs to another tab.
  const owner = useRef<string | null>(null)
  useEffect(() => {
    if (!tab || !statusReady) return
    const key = `${projectId}\0${tab.key}`
    // An explicit deselection stays empty until another tab is opened.
    if (owner.current === key && !ui.get().selection) return
    const moved = owner.current !== null && owner.current !== key
    owner.current = key
    const sel = ui.get().selection
    const stale = moved || (sel?.kind === "worktree" && dirtyFiles === 0) || (sel?.kind === "compare" && !showCompare)
    if (sel && !stale) return
    ui.set({ selection: dirtyFiles > 0 ? { kind: "worktree" } : tab.head ? { kind: "commit", hash: tab.head } : null, file: null })
  }, [tab?.key, tab?.head, statusReady, dirtyFiles, showCompare, selection === null]) // eslint-disable-line react-hooks/exhaustive-deps
}
