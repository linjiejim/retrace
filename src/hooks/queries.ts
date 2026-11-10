import { keepPreviousData, useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { prOfBranch } from "@/lib/github"
import type { BranchRef, BranchStatus, Overview, PreparedPr, PullRequest, Target, TreeStatus, Trunk, TrunkCompare, Worktree } from "@/lib/types"

export const targetKey = (t: Target | null) =>
  !t ? "" : t.kind === "commit" ? `c:${t.hash}` : t.kind === "worktree" ? `w:${t.tree}` : `x:${t.base}:${t.tip}`

export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: api.listProjects, staleTime: Infinity })

export const useGroups = () => useQuery({ queryKey: ["groups"], queryFn: api.listGroups, staleTime: Infinity })

export const summaryQuery = (id: string) => ({ queryKey: ["summary", id], queryFn: () => api.projectSummary(id), staleTime: 60_000 })

export const useSummary = (id: string) => useQuery(summaryQuery(id))

export const useOverview = (id: string | null) =>
  useQuery({ queryKey: ["overview", id], queryFn: () => api.overview(id!), enabled: !!id, staleTime: 30_000 })

export const useStatuses = (id: string | null) =>
  useQuery({ queryKey: ["statuses", id], queryFn: () => api.treeStatuses(id!), enabled: !!id, staleTime: 15_000, placeholderData: keepPreviousData })

export const useCompare = (id: string | null, tip: string | null, enabled: boolean) =>
  useQuery({ queryKey: ["compare", id, tip], queryFn: () => api.compare(id!, tip!), enabled: enabled && !!id && !!tip, staleTime: 60_000 })

export const HISTORY_PAGE = 500

/** History in pages; the backend keeps lane state between pages, so pages concatenate as-is. */
export const useHistory = (a: {
  id: string | null
  trunkTip: string | null
  tip: string | null
  worktreeHead: string | null
  allBranches: boolean
  remotes: boolean
  /** Only this file's history. */
  path: string | null
  /** First parents only, with these merges opened. */
  fold: boolean
  expanded: string[]
  /** Rows to load at first (opening a merge deep down keeps it loaded). */
  depth: number
}) =>
  useInfiniteQuery({
    queryKey: ["history", a.id, a.trunkTip, a.tip, a.worktreeHead, a.allBranches, a.remotes, a.path, a.fold, a.expanded],
    // Later pages reuse the first page's branch tips: a branch moving in between can't splice two histories.
    queryFn: ({ pageParam }) => api.history({ ...a, id: a.id!, offset: pageParam.offset, count: pageParam.count, tips: pageParam.tips }),
    initialPageParam: { offset: 0, count: Math.min(5000, Math.max(HISTORY_PAGE, a.depth)), tips: undefined } as { offset: number; count: number; tips: string[] | undefined },
    getNextPageParam: (last, pages) =>
      last.hasMore && !last.capped ? { offset: pages.reduce((n, p) => n + p.rows.length, 0), count: HISTORY_PAGE, tips: pages[0].tips } : undefined,
    enabled: !!a.id && !!(a.trunkTip || a.tip),
    staleTime: 60_000,
    // Folding or opening a merge keeps the rows on screen until the new layout arrives.
    placeholderData: (prev, prevQuery) => (prevQuery && sameHistory(prevQuery.queryKey, [a.id, a.trunkTip, a.tip, a.worktreeHead, a.allBranches, a.remotes, a.path]) ? prev : undefined),
  })

const sameHistory = (key: readonly unknown[], rest: unknown[]) => rest.every((v, i) => key[i + 1] === v)

export const usePatch = (id: string | null, target: Target | null, enabled: boolean) =>
  useQuery({
    queryKey: ["patch", id, targetKey(target)],
    queryFn: () => api.patch(id!, target!),
    enabled: enabled && !!id && !!target,
    staleTime: target?.kind === "commit" ? Infinity : 5_000,
  })

export const useCleanupCandidates = (id: string | null, enabled: boolean) =>
  useQuery({ queryKey: ["cleanup", id], queryFn: () => api.cleanupCandidates(id!), enabled: enabled && !!id, staleTime: 5_000 })

/** Local branches without a worktree, merged or not. Ref changes refresh it (`invalidateProject` with git). */
export const useBranchStatuses = (id: string | null) =>
  useQuery({ queryKey: ["branches", id], queryFn: () => api.branchStatuses(id!), enabled: !!id, staleTime: 30_000 })

/** Merged, not protected and not kept: what the Merged menu offers to delete. */
export const isRemovableBranch = (b: BranchStatus) => b.integration !== "none" && !b.protected && !b.kept

export const useCommit = (id: string | null, hash: string | null) =>
  useQuery({ queryKey: ["commit", id, hash], queryFn: () => api.commit(id!, hash!), enabled: !!id && !!hash, staleTime: Infinity })

export const useChanges = (id: string | null, target: Target | null) =>
  useQuery({
    queryKey: ["changes", id, targetKey(target)],
    queryFn: () => api.changes(id!, target!),
    enabled: !!id && !!target,
    // A commit never changes; uncommitted work and branch tips do.
    staleTime: target?.kind === "commit" ? Infinity : 5_000,
  })

export const useFilePair = (id: string | null, target: Target | null, file: { path: string; oldPath: string | null } | null) =>
  useQuery({
    queryKey: ["filePair", id, targetKey(target), file?.path, file?.oldPath],
    queryFn: () => api.filePair(id!, target!, file!.path, file!.oldPath),
    enabled: !!id && !!target && !!file,
    staleTime: target?.kind === "commit" ? Infinity : 5_000,
  })

export const useFiles = (id: string | null, target: Target | null, enabled: boolean) =>
  useQuery({
    queryKey: ["files", id, targetKey(target)],
    queryFn: () => api.files(id!, target!),
    enabled: enabled && !!id && !!target,
    staleTime: target?.kind === "worktree" ? 5_000 : Infinity,
    placeholderData: keepPreviousData,
  })

export const useFileContent = (id: string | null, target: Target | null, path: string | null, side: "new" | "old" = "new", oldPath?: string | null) =>
  useQuery({
    queryKey: ["fileContent", id, targetKey(target), path, side, oldPath ?? null],
    queryFn: () => api.fileContent(id!, target!, path!, side, oldPath),
    enabled: !!id && !!target && !!path,
    staleTime: target?.kind === "worktree" ? 5_000 : Infinity,
  })

/**
 * Open pull requests. `gh` takes a second or two and goes over the network, so file-system events
 * don't refresh it: it goes stale after two minutes and is read again on ⌘R or when the menu opens.
 */
export const pullsQuery = (id: string | null) => ({ queryKey: ["pulls", id], queryFn: () => api.pullRequests(id!), staleTime: 120_000 })

export const usePullRequests = (id: string | null, enabled: boolean) => useQuery({ ...pullsQuery(id), enabled: enabled && !!id })

/** The list as already read; never starts a gh call itself. */
export const useCachedPullRequests = (id: string | null) => useQuery({ ...pullsQuery(id), enabled: false })

export const usePullRequest = (id: string | null, n: number | null) =>
  useQuery({ queryKey: ["pull", id, n], queryFn: () => api.pullRequest(id!, n!), enabled: !!id && !!n, staleTime: 60_000 })

/** The open pull request whose head is this branch, from the list already read. */
export function useBranchPr(id: string | null, branch: string | null | undefined): PullRequest | undefined {
  return prOfBranch(useCachedPullRequests(id).data?.items, branch)
}

/** The remote the pull requests are read from: the one the trunk tracks, else `origin` (as the backend picks it). */
export const prRemote = (trunk: Trunk | null) => trunk?.remoteRef?.split("/")[0] || "origin"

/**
 * The branch name a pull request of the repository would have for this tab: a worktree's branch,
 * a local branch, or `x` for `<remote>/x` on the pull requests' own remote (other remotes are
 * other repositories).
 */
export function branchOfTab(tab: Tab | undefined, remote: string): string | null {
  if (!tab || tab.kind === "pr") return null
  if (tab.kind === "tree") return tab.tree?.branch ?? null
  const name = tab.branch?.name ?? tab.label
  if (!tab.branch?.remote) return name
  return name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : null
}

/** Its commits are here (fetched as objects if they weren't); keyed by the commits, so it never goes stale. */
export const usePreparedPr = (id: string | null, pr: PullRequest | undefined) =>
  useQuery({
    queryKey: ["preparedPr", id, pr?.number, pr?.headRefOid, pr?.baseRefOid],
    queryFn: () => api.preparePr(id!, pr!),
    enabled: !!id && !!pr,
    staleTime: Infinity,
    retry: false,
  })

export const usePrefs = () => useQuery({ queryKey: ["prefs"], queryFn: api.getPrefs, staleTime: Infinity })

/** After a file-system or fetch event: refresh what can have changed for this project. */
export function invalidateProject(qc: QueryClient, id: string, opts: { git: boolean; trees: string[] }) {
  qc.invalidateQueries({ queryKey: ["statuses", id] })
  qc.invalidateQueries({ queryKey: ["summary", id] })
  if (opts.git) {
    qc.invalidateQueries({ queryKey: ["overview", id] })
    qc.invalidateQueries({ queryKey: ["history", id] })
    qc.invalidateQueries({ queryKey: ["compare", id] })
    qc.invalidateQueries({ queryKey: ["branches", id] })
  }
  qc.invalidateQueries({ queryKey: ["cleanup", id] })
  qc.invalidateQueries({ queryKey: ["changes", id], predicate: (q) => !String(q.queryKey[2]).startsWith("c:") })
  qc.invalidateQueries({ queryKey: ["patch", id], predicate: (q) => !String(q.queryKey[2]).startsWith("c:") })
  qc.invalidateQueries({ queryKey: ["filePair", id], predicate: (q) => !String(q.queryKey[2]).startsWith("c:") })
  qc.invalidateQueries({ queryKey: ["files", id], predicate: (q) => String(q.queryKey[2]).startsWith("w:") })
  qc.invalidateQueries({ queryKey: ["fileContent", id], predicate: (q) => String(q.queryKey[2]).startsWith("w:") })
}

// ---------- tabs ----------

export interface Tab {
  key: string
  kind: "tree" | "branch" | "pr"
  /** Branch name, the folder name for a detached worktree, or `#N` for a pull request. */
  label: string
  /** A pull request's head only once its commits are here. */
  head: string | null
  tree?: Worktree
  status?: TreeStatus
  branch?: BranchRef
  /** Can't be closed (the trunk tab of a bare repository). */
  pinned?: boolean
  /** The pull request tab: its number always, the rest once read. */
  prNumber?: number
  pr?: PullRequest
  prepared?: PreparedPr
}

export const treeKey = (path: string) => `tree:${path}`
export const branchKey = (name: string) => `branch:${name}`
export const prKey = (n: number) => `pr:${n}`

/** The pull request opened as a tab, as far as it has loaded. */
export interface PrSlot {
  number: number
  pr: PullRequest | undefined
  prepared: PreparedPr | undefined
}

/**
 * A linked worktree with nothing uncommitted whose HEAD is already in the trunk: safe to delete.
 * Also one whose folder is already gone, by the HEAD git recorded: only that record is left.
 */
export function isArchived(tab: Tab, trunk: Trunk | null): boolean {
  const t = tab.tree
  const s = tab.status
  if (!t || t.isMain || t.bare || t.locked || !s) return false
  if (t.branch && t.branch === trunk?.name) return false
  const merged = !!s.trunk && s.trunk.integration !== "none"
  if (s.missing) return t.prunable && merged
  if (t.prunable || s.error) return false
  return s.files === 0 && !s.operation && merged
}

export function buildTabs(ov: Overview | undefined, statuses: TreeStatus[] | undefined, branchTabs: string[], prSlot: PrSlot | null = null): Tab[] {
  if (!ov) return []
  const tabs: Tab[] = ov.trees
    .filter((t) => !t.bare)
    .map((t) => ({
      key: treeKey(t.path),
      kind: "tree",
      label: t.branch ?? `${t.path.split("/").pop()} @${t.head?.slice(0, 7) ?? ""}`,
      head: t.head,
      tree: t,
      status: statuses?.find((s) => s.path === t.path),
    }))
  // Bare repository: no worktree to show, so the trunk gets a fixed tab.
  if (tabs.length === 0 && ov.trunk) {
    tabs.push({ key: branchKey(ov.trunk.name), kind: "branch", label: ov.trunk.name, head: ov.trunk.tip, pinned: true })
  }
  for (const name of branchTabs) {
    if (tabs.some((t) => t.key === branchKey(name))) continue
    const b = ov.branches.find((x) => x.name === name)
    if (b) tabs.push({ key: branchKey(name), kind: "branch", label: name, head: b.tip, branch: b })
  }
  // Listed while it loads, so the tab doesn't fall back to the main tree in the meantime.
  if (prSlot) {
    const { number, pr, prepared } = prSlot
    tabs.push({ key: prKey(number), kind: "pr", label: pr ? `#${number} ${pr.title}` : `#${number}`, head: pr && prepared ? pr.headRefOid : null, prNumber: number, pr, prepared })
  }
  return tabs
}

export function compareOf(tab: Tab | undefined, branchCompare: TrunkCompare | undefined): TrunkCompare | null {
  if (!tab) return null
  // A pull request is compared with its own base, which needn't be the trunk.
  if (tab.kind === "pr") return tab.prepared ? { ahead: tab.prepared.ahead, behind: 0, integration: "none" } : null
  return tab.kind === "tree" ? (tab.status?.trunk ?? null) : (branchCompare ?? null)
}
