import { useEffect, useMemo, useRef } from "react"
import { buildTabs, compareOf, useCompare, useOverview, usePreparedPr, usePullRequest, usePullRequests, useStatuses, type Tab } from "./queries"
import { ui, useStore, type Selection } from "@/lib/store"
import type { Target, Trunk } from "@/lib/types"
import { inTauri } from "@/lib/api"

const NONE: string[] = []

/** Everything the history and detail panes derive from the selected project and tab. */
export function useProjectView() {
  const projectId = useStore(ui, (s) => s.projectId)
  const tabKey = useStore(ui, (s) => (projectId ? s.tabs[projectId] : undefined))
  const branchTabs = useStore(ui, (s) => (projectId ? s.branchTabs[projectId] : undefined)) ?? NONE
  const prNumber = useStore(ui, (s) => (projectId ? s.prTabs[projectId] : undefined)) ?? null
  const overview = useOverview(projectId)
  const statuses = useStatuses(projectId)
  const pulls = usePullRequests(projectId, !!overview.data?.webUrl)
  // The listed one shows at once; reading it alone adds the description and fresher checks.
  const prRead = usePullRequest(projectId, prNumber)
  const pr = prRead.data ?? pulls.data?.items.find((p) => p.number === prNumber)
  const prepared = usePreparedPr(projectId, pr)
  const tabs = useMemo(
    () => buildTabs(overview.data, statuses.data, branchTabs, prNumber ? { number: prNumber, pr, prepared: prepared.data } : null),
    [overview.data, statuses.data, branchTabs, prNumber, pr, prepared.data],
  )
  const tab: Tab | undefined = tabs.find((t) => t.key === tabKey) ?? tabs.find((t) => t.tree?.isMain) ?? tabs[0]
  const trunk = overview.data?.trunk ?? null
  const branchCompare = useCompare(projectId, tab?.head ?? null, tab?.kind === "branch" && !!trunk && tab.head !== trunk.tip)
  const compare = compareOf(tab, branchCompare.data)
  const dirtyFiles = tab?.kind === "tree" ? (tab.status?.files ?? 0) : 0
  /** "Everything this branch adds" makes sense only when the tab is not the trunk itself. */
  const showCompare = tab?.kind === "pr" ? (compare?.ahead ?? 0) > 0 : !!trunk && !!tab?.head && tab.head !== trunk.tip && (compare?.ahead ?? 0) > 0
  /** Why the pull request tab can't show its commits yet: reading it, or fetching them, failed. */
  const prError = tab?.kind === "pr" ? ((!pr && prRead.error) || prepared.error || null) : null
  const retryPr = () => (pr ? prepared.refetch() : prRead.refetch())
  return { projectId, overview, statuses, pulls, tabs, tab, trunk, compare, dirtyFiles, showCompare, prError, retryPr, inTauri }
}

export function targetOf(sel: Selection | null, tab: Tab | undefined, trunk: Trunk | null): Target | null {
  if (!tab) return null
  // With no graph row selected, browse the current worktree's uncommitted changes and files.
  if (!sel) return tab.tree ? { kind: "worktree", tree: tab.tree.path } : null
  if (sel.kind === "commit") return { kind: "commit", hash: sel.hash }
  if (sel.kind === "worktree") return tab.tree ? { kind: "worktree", tree: tab.tree.path } : null
  // A pull request: what GitHub's Files changed shows, against its own base.
  if (tab.kind === "pr") return tab.pr && tab.head ? { kind: "compare", base: tab.pr.baseRefOid, tip: tab.pr.headRefOid } : null
  return trunk && tab.head ? { kind: "compare", base: trunk.tip, tip: tab.head } : null
}

/**
 * Default selection for a tab: uncommitted work if any, a pull request's whole change, else the
 * tab's HEAD. Lives at the app level because any view can be hidden or moved. Worktree tabs wait
 * for their own status entry, pull request tabs for their commits.
 */
export function useDefaultSelection() {
  const { projectId, tab, statuses, dirtyFiles, showCompare } = useProjectView()
  const selection = useStore(ui, (s) => s.selection)
  const statusReady = tab?.kind === "pr" ? !!tab.prepared : tab?.kind !== "tree" || (!!tab.status && !statuses.isPlaceholderData)
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
    const next: Selection | null =
      dirtyFiles > 0 ? { kind: "worktree" } : tab.kind === "pr" && showCompare ? { kind: "compare" } : tab.head ? { kind: "commit", hash: tab.head } : null
    // A pull request's whole change starts as its description, with no file picked.
    ui.set({ selection: next, file: null, noFile: next?.kind === "compare" && tab.kind === "pr" })
  }, [tab?.key, tab?.head, statusReady, dirtyFiles, showCompare, selection === null]) // eslint-disable-line react-hooks/exhaustive-deps
}
