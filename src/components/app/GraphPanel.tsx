import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Archive, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, FolderGit2, GitBranch, GitCompareArrows, History, House, PanelLeftOpen, Pin, PinOff, RefreshCw, Search, SlidersHorizontal, Tag, X } from "lucide-react"
import { api } from "@/lib/api"
import { pickRow, run, showFileHistory } from "@/lib/commands"
import { absoluteTime, ago, relativeTime, shortHash, tildify } from "@/lib/format"
import { keyNav } from "@/lib/keys"
import { prefs, selectionKey, ui, useStore, type Selection } from "@/lib/store"
import { WORKTREE_ROW, type BranchStatus, type HistoryRow, type Overview, type RefLabel, type Trunk } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { branchKey, invalidateProject, isArchived, isRemovableBranch, useBranchStatuses, useChanges, useHistory, type Tab } from "@/hooks/queries"
import { useProjectView } from "@/hooks/use-project-view"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"
import { IconButton } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { StateView } from "@/components/ui/state"
import { Switch } from "@/components/ui/switch"
import { Tooltip } from "@/components/ui/tooltip"
import { notify } from "@/components/ui/toast"
import { PanelHeader } from "@/components/layout/LayoutView"
import { ArchiveMenu } from "./ArchiveMenu"
import { Lanes, lanesWidth, ROW_H } from "./Lanes"

type View = ReturnType<typeof useProjectView>

export function GraphPanel() {
  const view = useProjectView()
  const collapsed = useStore(prefs, (s) => s.projectsCollapsed)
  const { projectId, overview, tab, trunk } = view
  const historyFile = useStore(ui, (s) => s.historyFile)

  return (
    <section className="flex h-full min-w-0 flex-col">
      <PanelHeader className="gap-0.5">
        {collapsed && (
          <IconButton label={`${t("Show projects")}  ⌘\\`} size="icon-sm" onClick={() => run("toggleProjects")}>
            <PanelLeftOpen />
          </IconButton>
        )}
        {overview.data ? <TabsBar view={view} /> : <span data-tauri-drag-region className="h-full flex-1" />}
        {overview.data && <GraphTools view={view} />}
      </PanelHeader>
      {!projectId ? (
        <StateView kind="empty" title={t("Pick a project")} description={t("Choose one in the projects list, or add one first.")} />
      ) : overview.isError ? (
        <StateView kind="error" description={String(overview.error?.message ?? "")} onRetry={() => overview.refetch()} />
      ) : !overview.data ? (
        <GraphSkeleton />
      ) : tab ? (
        <>
          {historyFile && <FileHistoryBar path={historyFile} />}
          <Graph key={`${projectId}:${tab.key}:${historyFile ?? ""}`} view={view} tab={tab} trunk={trunk} overview={overview.data} path={historyFile} />
        </>
      ) : null}
    </section>
  )
}

// ---------- tabs ----------

/**
 * One row: the main tree, then three folded groups — worktrees in progress, worktrees and branches
 * already in the trunk, and branches without a worktree still in progress. The group holding the
 * shown tab displays its name.
 */
function TabsBar({ view }: { view: View }) {
  const qc = useQueryClient()
  const { projectId, tabs, tab, trunk, overview } = view
  const open = (key: string) => ui.set((s) => ({ tabs: { ...s.tabs, [projectId!]: key }, selection: null, file: null, historyFile: null, focusMode: false }))
  const openBranch = (name: string) =>
    ui.set((s) => ({
      branchTabs: { ...s.branchTabs, [projectId!]: [name] },
      tabs: { ...s.tabs, [projectId!]: branchKey(name) },
      selection: null,
      file: null,
      historyFile: null,
    }))
  const archived = tabs.filter((t) => isArchived(t, trunk))
  const main = tabs.filter((t) => t.tree?.isMain || t.pinned)
  const active = tabs.filter((t) => t.kind === "tree" && !main.includes(t) && !archived.includes(t))
  const current = (group: Tab[]) => (tab && group.includes(tab) ? tab : null)
  const branchTab = tab?.kind === "branch" && !tab.pinned ? tab : null

  const ov = overview.data!
  const statuses = useBranchStatuses(projectId).data
  const statusOf = useMemo(() => new Map((statuses ?? []).map((b) => [b.name, b])), [statuses])
  const localNames = useMemo(() => new Set(ov.branches.filter((b) => !b.remote).map((b) => b.name)), [ov.branches])
  // Merged branches go to the Merged group; the statuses may be a moment older than the overview.
  const removable = useMemo(() => (statuses ?? []).filter((b) => isRemovableBranch(b) && localNames.has(b.name)), [statuses, localNames])
  const removableNames = new Set(removable.map((b) => b.name))
  const checkedOut = new Set(ov.trees.map((t) => t.branch).filter(Boolean))
  // `origin/x` is redundant when `x` exists locally, is checked out, or is the trunk.
  const bare = (b: { name: string; remote: boolean }) => (b.remote ? b.name.slice(b.name.indexOf("/") + 1) : b.name)
  const others = ov.branches.filter((b) => {
    const n = bare(b)
    if (checkedOut.has(n) || n === trunk?.name || n === "HEAD") return false
    if (!b.remote && removableNames.has(n)) return false
    return !(b.remote && localNames.has(n))
  })
  const mergedBranchTab = branchTab && removableNames.has(branchTab.label) ? branchTab : null
  const listBranchTab = mergedBranchTab ? null : branchTab

  const unkeep = async (name: string) => {
    try {
      await api.keepBranch(projectId!, name, false)
      qc.invalidateQueries({ queryKey: ["branches", projectId] })
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {main.map((t) => (
        <MainTab key={t.key} tab={t} trunk={trunk} selected={t.key === tab?.key} onOpen={() => open(t.key)} />
      ))}
      {active.length > 0 && <TreeMenu tabs={active} current={current(active)} trunk={trunk} onOpen={(t) => open(t.key)} />}
      {(archived.length > 0 || removable.length > 0) && (
        <ArchiveMenu view={view} archived={archived} branches={removable} onOpen={(t) => open(t.key)} onOpenBranch={openBranch}>
          <GroupTrigger icon={<Archive />} label={t("Merged")} count={archived.length + removable.length} current={current(archived) ?? mergedBranchTab} trunk={trunk} />
        </ArchiveMenu>
      )}
      {(others.length > 0 || listBranchTab) && (
        <BranchPicker
          title={t("Branches without a worktree: in progress or kept")}
          branches={others.map((b) => {
            const st = b.remote ? undefined : statusOf.get(b.name)
            return { name: b.name, remote: b.remote, meta: st && <BranchMeta status={st} trunk={trunk} />, action: st?.kept && st.integration !== "none" ? { label: t("Stop keeping {name}", { name: b.name }), onClick: () => unkeep(b.name) } : undefined }
          })}
          current={listBranchTab?.label}
          onPick={openBranch}
        >
          <GroupTrigger icon={<GitBranch />} label={t("Branches")} count={others.length} current={listBranchTab} trunk={trunk} />
        </BranchPicker>
      )}
      <span data-tauri-drag-region className="h-full min-w-2 flex-1" />
    </div>
  )
}

/** What a branch in the Branches list still has to do with the trunk. */
function BranchMeta({ status: b, trunk }: { status: BranchStatus; trunk: Trunk | null }) {
  const trunkName = trunk?.name ?? t("the trunk")
  if (b.integration !== "none") {
    return b.kept ? (
      <Tooltip content={t("In {trunk}; you chose to keep it", { trunk: trunkName })}>
        <span className="shrink-0 text-caption text-faint-foreground">{t("Kept")}</span>
      </Tooltip>
    ) : (
      <Tooltip content={t("In {trunk}; long-lived names like develop and release/* are never offered for removal", { trunk: trunkName })}>
        <span className="shrink-0 text-caption text-faint-foreground">{t("Long-lived")}</span>
      </Tooltip>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-caption text-faint-foreground">
      {b.upstreamGone && (
        <Tooltip content={t("The remote branch it tracked was deleted: merged by other means, or abandoned. Worth a look")}>
          <span className="text-warning">{t("Remote deleted")}</span>
        </Tooltip>
      )}
      {b.ahead > 0 && <span className="tabular" aria-label={tp("{n} commit not in {trunk}", "{n} commits not in {trunk}", b.ahead, { trunk: trunkName })}>↑{b.ahead}</span>}
      {b.lastCommitAt && <span>{ago(b.lastCommitAt)}</span>}
    </span>
  )
}

function MainTab({ tab, trunk, selected, onOpen }: { tab: Tab; trunk: Trunk | null; selected: boolean; onOpen: () => void }) {
  const tip = tab.tree ? `${t("Main worktree")}\n${tildify(tab.tree.path)}` : t("Branch {name} (no worktree)", { name: tab.label })
  return (
    <Tooltip content={<span className="whitespace-pre-line">{tip}</span>} side="bottom" delayDuration={700}>
      <button
        onClick={onOpen}
        className={cn(
          "inline-flex h-[26px] min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-2 text-small text-muted-foreground hover:bg-accent",
          selected && "bg-pressed font-medium text-foreground hover:bg-pressed",
        )}
      >
        <House className="size-3.5 shrink-0" />
        <span className="@max-[420px]/header:hidden">{t("Main")}</span>
        {tab.label !== trunk?.name && <span className="max-w-[140px] truncate font-normal text-faint-foreground @max-[560px]/header:hidden">{tab.label}</span>}
        <TabBadges tab={tab} trunk={trunk} />
      </button>
    </Tooltip>
  )
}

/** Trigger of a folded group: its name and size, or the name of the tab it holds when that tab is shown. */
function GroupTrigger({
  icon,
  label,
  count,
  current,
  trunk,
  className,
  ...rest
}: React.ComponentProps<"button"> & { icon: React.ReactNode; label: string; count: number; current: Tab | null; trunk: Trunk | null }) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex h-[26px] min-w-0 shrink items-center gap-1.5 rounded-sm pl-2 pr-1.5 text-small text-muted-foreground hover:bg-accent data-[state=open]:bg-pressed [&>svg]:size-3.5 [&>svg]:shrink-0",
        current && "bg-pressed font-medium text-foreground",
        className,
      )}
    >
      {icon}
      {current ? (
        <>
          <span className="min-w-0 max-w-[180px] truncate">{current.label}</span>
          <TabBadges tab={current} trunk={trunk} />
        </>
      ) : (
        <>
          <span className="@max-[520px]/header:hidden">{label}</span>
          <span className="tabular text-faint-foreground">{count}</span>
        </>
      )}
      <ChevronDown />
    </button>
  )
}

/** Linked worktrees still being worked on: uncommitted files, or commits not yet in the trunk. */
function TreeMenu({ tabs, current, trunk, onOpen }: { tabs: Tab[]; current: Tab | null; trunk: Trunk | null; onOpen: (t: Tab) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <GroupTrigger icon={<FolderGit2 />} label={t("Active")} count={tabs.length} current={current} trunk={trunk} />
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <div className="px-3 pb-1 pt-2.5 text-caption text-faint-foreground">{t("Worktrees with uncommitted changes, or not yet in {trunk}", { trunk: trunk?.name ?? t("the trunk") })}</div>
        <ul className="max-h-[50vh] overflow-y-auto px-1 pb-1">
          {tabs.map((t) => (
            <li key={t.key}>
              <button
                onClick={() => {
                  onOpen(t)
                  setOpen(false)
                }}
                className={cn("flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent", t.key === current?.key && "bg-selected hover:bg-selected")}
              >
                <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-body font-medium">{t.label}</span>
                    <TabBadges tab={t} trunk={trunk} />
                  </span>
                  <span className="block truncate text-caption text-faint-foreground">{t.tree ? tildify(t.tree.path) : ""}</span>
                </span>
                {t.key === current?.key && <Check className="mt-0.5 size-4 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

const OPERATION: Record<string, string> = { merge: "Merging", rebase: "Rebasing", "cherry-pick": "Cherry-picking", revert: "Reverting", bisect: "Bisecting" }

function TabBadges({ tab, trunk }: { tab: Tab; trunk: Trunk | null }) {
  const s = tab.status
  const cmp = tab.kind === "tree" ? s?.trunk : null
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-caption font-normal">
      {s?.operation && <span className="text-warning">{t(OPERATION[s.operation])}</span>}
      {!!s?.files && (
        <span className="tabular text-warning" aria-label={tp("{n} uncommitted file", "{n} uncommitted files", s.files)}>
          ●{s.files}
        </span>
      )}
      {cmp && cmp.integration !== "none" && !s?.files ? (
        <CircleCheck className="size-3.5 text-success" aria-label={t("In {trunk}", { trunk: trunk?.name ?? t("the trunk") })} />
      ) : cmp && (cmp.ahead || cmp.behind) ? (
        <span className="tabular text-faint-foreground">
          {cmp.ahead ? `↑${cmp.ahead}` : ""}
          {cmp.ahead && cmp.behind ? " " : ""}
          {cmp.behind ? `↓${cmp.behind}` : ""}
        </span>
      ) : null}
    </span>
  )
}

type BranchItem = { name: string; remote: boolean; meta?: React.ReactNode; action?: { label: string; onClick: () => void } }

/** Filterable branch list; used for opening a branch and for picking the integration branch. */
function BranchList({
  title,
  branches,
  current,
  auto,
  onPick,
  onBack,
}: {
  title: string
  branches: BranchItem[]
  current?: string
  auto?: { label: string; on: boolean; onPick: () => void }
  onPick: (name: string) => void
  onBack?: () => void
}) {
  const [q, setQ] = useState("")
  const list = branches.filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-1 pt-1.5 text-caption text-faint-foreground">
        {onBack && (
          <button aria-label={t("Back")} onClick={onBack} className="-ml-1 inline-flex size-5 items-center justify-center rounded-xs hover:bg-accent hover:text-foreground">
            <ChevronLeft className="size-3.5" />
          </button>
        )}
        {title}
      </div>
      {branches.length > 8 && (
        <label className="mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-sm px-2 text-faint-foreground ring-1 ring-border focus-within:ring-ring">
          <Search className="size-3.5" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Filter branches")} className="w-full bg-transparent text-small text-foreground outline-none" />
        </label>
      )}
      <div className="max-h-80 overflow-y-auto">
        {auto && (
          <button onClick={auto.onPick} className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-body hover:bg-accent">
            <Pin className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{auto.label}</span>
            {auto.on && <Check className="size-4" />}
          </button>
        )}
        {list.slice(0, 300).map((b) => (
          <div key={b.name} className="flex items-center rounded-sm hover:bg-accent">
            <button onClick={() => onPick(b.name)} className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-body">
              <GitBranch className={cn("size-4 shrink-0", b.remote ? "text-faint-foreground" : "text-muted-foreground")} />
              <span className={cn("min-w-0 flex-1 truncate", b.remote && "text-muted-foreground")}>{b.name}</span>
              {b.meta}
              {current === b.name && <Check className="size-4 shrink-0" />}
            </button>
            {b.action && (
              <IconButton label={b.action.label} size="icon-sm" className="mr-1 text-faint-foreground" onClick={b.action.onClick}>
                <PinOff />
              </IconButton>
            )}
          </div>
        ))}
        {list.length > 300 && <div className="px-2 py-2 text-caption text-faint-foreground">{t("{n} more — type to filter", { n: list.length - 300 })}</div>}
        {list.length === 0 && <div className="px-2 py-3 text-small text-faint-foreground">{t("No matching branches")}</div>}
      </div>
    </>
  )
}

function BranchPicker({ children, onPick, ...props }: Omit<React.ComponentProps<typeof BranchList>, "onBack"> & { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-1" align="start">
        <BranchList
          {...props}
          onPick={(name) => {
            onPick(name)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------- tools: search, options, refresh ----------

function GraphTools({ view }: { view: View }) {
  const query = useStore(ui, (s) => s.query)
  const fetching = useStore(ui, (s) => s.fetching)
  const input = useRef<HTMLInputElement>(null)
  keyNav.focusSearch = () => input.current?.select()
  return (
    <>
      {/* Always open; narrower headers give the tabs room first. */}
      <Tooltip content={`${t("Filter commits")}  ⌘F`} side="bottom" delayDuration={700}>
        <label className="flex h-6 w-[200px] shrink-0 items-center gap-1.5 rounded-sm bg-background px-2 text-faint-foreground ring-1 ring-border focus-within:ring-ring @max-[640px]/header:w-[150px] @max-[480px]/header:w-[110px] @max-[380px]/header:w-[80px]">
          <Search className="size-3.5 shrink-0" />
          <input
            ref={input}
            value={query}
            onChange={(e) => ui.set({ query: e.target.value })}
            placeholder={t("Filter commits, authors, hashes")}
            aria-label={t("Filter commits")}
            className="w-full min-w-0 bg-transparent text-caption text-foreground outline-none placeholder:text-faint-foreground"
          />
          {query && (
            <button aria-label={t("Clear filter")} onMouseDown={(e) => e.preventDefault()} onClick={() => ui.set({ query: "" })} className="shrink-0 hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </Tooltip>
      <GraphOptions view={view} />
      <IconButton label={fetching ? t("Fetching from the remote") : `${t("Refresh and fetch")}  ⌘R`} size="icon-sm" onClick={() => run("refresh")}>
        <RefreshCw className={cn(fetching && "animate-spin")} />
      </IconButton>
    </>
  )
}

/** The integration branch and which branches the graph draws. */
function GraphOptions({ view }: { view: View }) {
  const qc = useQueryClient()
  const { projectId, overview, trunk } = view
  const others = useStore(prefs, (s) => s.otherBranches)
  const remotes = useStore(prefs, (s) => s.remoteBranches)
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const ov = overview.data!
  const setTrunk = async (branch: string | null) => {
    setPicking(false)
    await api.setTrunk(projectId!, branch)
    qc.invalidateQueries({ queryKey: ["projects"] })
    invalidateProject(qc, projectId!, { git: true, trees: [] })
  }
  const branches = [...ov.branches.filter((b) => !b.remote), ...ov.branches.filter((b) => b.remote)].map((b) => ({ name: b.name, remote: b.remote }))

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setPicking(false)
      }}
    >
      <PopoverTrigger asChild>
        <span className="inline-flex">
          <IconButton label={t("Graph options")} size="icon-sm" className={cn(others && "text-primary")}>
            <SlidersHorizontal />
          </IconButton>
        </span>
      </PopoverTrigger>
      <PopoverContent className={cn(picking ? "w-80 p-1" : "w-72")} align="end">
        {picking ? (
          <BranchList
            title={t("The integration branch stays in the leftmost column")}
            branches={branches}
            current={ov.project.trunkOverride ?? undefined}
            auto={{ label: t("Detect automatically (origin/HEAD → main / master)"), on: !ov.project.trunkOverride, onPick: () => setTrunk(null) }}
            onPick={(name) => setTrunk(name)}
            onBack={() => setPicking(false)}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-body">
              <span className="flex-1">
                {t("Integration branch")}
                <span className="block text-caption text-faint-foreground">{t("Pinned to the graph's leftmost column")}</span>
              </span>
              <button onClick={() => setPicking(true)} className="inline-flex h-7 max-w-[150px] items-center gap-1 rounded-sm px-2 text-small ring-1 ring-border hover:bg-accent">
                <span className="truncate font-medium text-primary">{trunk?.name ?? t("Not found")}</span>
                <ChevronRight className="size-3.5 shrink-0 text-faint-foreground" />
              </button>
            </div>
            <div className="border-t" />
            <label className="flex items-center gap-3 text-body">
              <span className="flex-1">
                {t("Show other branches")}
                <span className="block text-caption text-faint-foreground">{t("By default only the integration branch and the current tab are drawn")}</span>
              </span>
              <Switch checked={others} onCheckedChange={(v) => prefs.set({ otherBranches: v })} />
            </label>
            <label className={cn("flex items-center gap-2 text-body", !others && "text-faint-foreground")}>
              <Checkbox disabled={!others} checked={remotes} onCheckedChange={(v) => prefs.set({ remoteBranches: v === true })} />
              {t("Include remote branches")}
            </label>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---------- graph ----------

/** Above the graph while it lists one file's commits. */
function FileHistoryBar({ path }: { path: string }) {
  const name = path.split("/").pop()
  const dir = path.slice(0, -(name?.length ?? 0))
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b bg-primary-subtle pl-3 pr-1.5 text-caption">
      <History className="size-3.5 shrink-0 text-primary" />
      <span className="shrink-0 text-muted-foreground">{t("History of")}</span>
      <Tooltip content={t("Only the commits that changed this file (renames aren't followed)")} side="bottom">
        <span className="selectable min-w-0 flex-1 truncate font-mono [direction:rtl] [text-align:left]">
          <span className="[unicode-bidi:plaintext]">
            <span className="text-faint-foreground">{dir}</span>
            <span className="font-medium text-foreground">{name}</span>
          </span>
        </span>
      </Tooltip>
      <IconButton label={t("Show all commits")} size="icon-sm" onClick={() => showFileHistory(null)}>
        <X />
      </IconButton>
    </div>
  )
}

function GraphSkeleton() {
  const shown = useDelayedFlag(true)
  if (!shown) return null
  return (
    <div className="pt-8">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex h-[26px] items-center gap-3 px-3">
          <Skeleton className="size-2.5 rounded-full" />
          <div style={{ width: `${40 + ((i * 37) % 45)}%` }}>
            <Skeleton className="h-3" />
          </div>
        </div>
      ))}
    </div>
  )
}

type Item = { kind: "compare" } | { kind: "row"; row: HistoryRow }
const keyOf = (it: Item) => (it.kind === "compare" ? "compare" : it.row.id === WORKTREE_ROW ? "worktree" : it.row.id)
const selectionOf = (it: Item): Selection =>
  it.kind === "compare" ? { kind: "compare" } : it.row.id === WORKTREE_ROW ? { kind: "worktree" } : { kind: "commit", hash: it.row.id }
/** Keyboard: move the selection, leave the diff as it is. */
const selectItem = (it: Item) => ui.set({ selection: selectionOf(it), focusArea: "graph" })
/** Click (module-level so memoised rows get a stable callback): open the row or deselect it. */
const clickItem = (it: Item) => pickRow(selectionOf(it))

function Graph({ view, tab, trunk, overview, path }: { view: View; tab: Tab; trunk: Trunk | null; overview: Overview; path: string | null }) {
  const { projectId, dirtyFiles, compare } = view
  // One file's history leaves out "everything since the trunk": it isn't a commit to the file.
  const showCompare = view.showCompare && !path
  const others = useStore(prefs, (s) => s.otherBranches)
  const remotes = useStore(prefs, (s) => s.remoteBranches)
  // In a file's history the uncommitted row shows only when that file is among the uncommitted changes.
  const worktree = useChanges(projectId, path && dirtyFiles > 0 && tab.tree ? { kind: "worktree", tree: tab.tree.path } : null)
  const fileDirty = !!worktree.data?.some((f) => f.path === path)
  const waiting = !!path && dirtyFiles > 0 && !!tab.tree && !worktree.data && !worktree.isError
  const history = useHistory({
    id: waiting ? null : projectId,
    trunkTip: trunk?.tip ?? null,
    tip: tab.head,
    worktreeHead: dirtyFiles > 0 && (!path || fileDirty) ? tab.head : null,
    allBranches: others,
    remotes: others && remotes,
    path,
  })
  const selection = useStore(ui, (s) => s.selection)
  const query = useStore(ui, (s) => s.query).trim().toLowerCase()
  const scroller = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => history.data?.pages.flatMap((p) => p.rows), [history.data])
  const capped = history.data?.pages.at(-1)?.capped ?? false
  const items: Item[] = useMemo(
    () => [...(showCompare ? [{ kind: "compare" } as Item] : []), ...(rows ?? []).map((row): Item => ({ kind: "row", row }))],
    [rows, showCompare],
  )
  const width = useMemo(() => {
    let max = 0
    for (const r of rows ?? []) {
      if (r.col > max) max = r.col
      for (const s of r.segs) max = Math.max(max, s[1], s[2])
    }
    return lanesWidth(max)
  }, [rows])
  const matches = useMemo(() => {
    if (!query || !rows) return null
    return new Set(rows.filter((r) => r.id !== WORKTREE_ROW && (r.subject.toLowerCase().includes(query) || r.author.toLowerCase().includes(query) || r.id.startsWith(query))).map((r) => r.id))
  }, [rows, query])

  const v = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 20 })
  const virtualItems = v.getVirtualItems()
  const last = virtualItems[virtualItems.length - 1]?.index ?? 0
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && last > items.length - 60) fetchNextPage()
  }, [last, items.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  // A branch far behind the trunk has its HEAD below the first page: keep loading until it shows up.
  // (A file's history may not hold the HEAD at all.)
  const headLoaded = !tab.head || !!path || !!rows?.some((r) => r.id === tab.head)
  useEffect(() => {
    if (rows && !headLoaded && hasNextPage && !isFetchingNextPage) fetchNextPage()
  }, [rows, headLoaded, hasNextPage, isFetchingNextPage, fetchNextPage])

  const selKey = selectionKey(selection)

  // On opening a tab, bring the selected row (its HEAD or uncommitted work) into view once.
  const revealed = useRef(false)
  useEffect(() => {
    if (revealed.current || !rows || !selKey) return
    const i = items.findIndex((it) => keyOf(it) === selKey)
    if (i < 0) return
    revealed.current = true
    if (i > 8) v.scrollToIndex(i, { align: "center" })
  }, [rows, selKey]) // eslint-disable-line react-hooks/exhaustive-deps

  keyNav.graph = (dir) => {
    const i = items.findIndex((it) => keyOf(it) === selKey)
    const next = items[Math.max(0, Math.min(items.length - 1, i + dir))]
    if (!next) return
    selectItem(next)
    v.scrollToIndex(items.indexOf(next), { align: "auto" })
  }

  if (!trunk?.tip && !tab.head) return <StateView kind="empty" title={t("No commits yet")} description={dirtyFiles ? t("Changes lists the files not committed yet.") : undefined} />
  if (history.isError) return <StateView kind="error" description={history.error.message} onRetry={() => history.refetch()} />
  if (!rows) return <GraphSkeleton />
  if (items.length === 0) return path ? <StateView kind="empty" title={t("No commits change this file")} description={t("It may only exist under another name in earlier commits.")} /> : <StateView kind="empty" title={t("No commits yet")} />

  return (
    <div ref={scroller} tabIndex={-1} onMouseDown={() => ui.set({ focusArea: "graph" })} className="@container relative min-h-0 flex-1 overflow-y-auto outline-none">
      <div className="relative" style={{ height: v.getTotalSize() + 28 }}>
        {virtualItems.map((vi) => {
          const it = items[vi.index]
          const key = keyOf(it)
          return (
            <GraphRow
              key={key}
              item={it}
              top={vi.start}
              width={width}
              selected={key === selKey}
              dim={!!matches && it.kind === "row" && it.row.id !== WORKTREE_ROW && !matches.has(it.row.id)}
              query={query}
              labels={it.kind === "row" ? overview.refs[it.row.id] : undefined}
              trunk={trunk}
              isHead={it.kind === "row" && it.row.id === tab.head && dirtyFiles === 0}
              compareAhead={compare?.ahead ?? 0}
              dirtyFiles={path ? 0 : dirtyFiles}
              treePath={tab.tree?.path}
              onSelect={clickItem}
            />
          )
        })}
        <div className="absolute inset-x-0 px-3 text-caption text-faint-foreground" style={{ top: v.getTotalSize() + 6 }}>
          {hasNextPage ? t("Loading earlier commits…") : capped ? t("Showing the latest {n} commits", { n: rows.length }) : tp("{n} commit", "{n} commits", rows.filter((r) => r.id !== WORKTREE_ROW).length)}
        </div>
      </div>
    </div>
  )
}

/** One graph row; memoised so moving the selection repaints two rows, not the whole window. */
const GraphRow = memo(function GraphRow(p: {
  item: Item
  top: number
  width: number
  selected: boolean
  dim: boolean
  query: string
  labels: RefLabel[] | undefined
  trunk: Trunk | null
  isHead: boolean
  compareAhead: number
  dirtyFiles: number
  treePath: string | undefined
  onSelect: (it: Item) => void
}) {
  const style = { transform: `translateY(${p.top}px)` }
  const base = "absolute inset-x-0 top-0 flex h-[26px] items-center gap-2 whitespace-nowrap pr-3 text-small"
  const tone = p.selected ? "bg-selected" : "hover:bg-accent"
  if (p.item.kind === "compare") {
    return (
      <div style={style} className={cn(base, tone)} onClick={() => p.onSelect(p.item)}>
        <span className="flex shrink-0 justify-start pl-[5px] text-primary" style={{ width: p.width }}>
          <GitCompareArrows className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{t("Everything since {trunk}", { trunk: p.trunk?.name ?? "" })}</span>
        <span className="shrink-0 text-caption tabular text-faint-foreground">{tp("{n} commit", "{n} commits", p.compareAhead)}</span>
      </div>
    )
  }
  const r = p.item.row
  if (r.id === WORKTREE_ROW) {
    return (
      <div style={style} className={cn(base, tone)} onClick={() => p.onSelect(p.item)}>
        <Lanes row={r} width={p.width} isHead={false} isWorktree />
        <span className="min-w-0 flex-1 truncate font-medium text-warning">
          {t("Uncommitted changes")}
          {p.dirtyFiles > 0 && ` · ${tp("{n} file", "{n} files", p.dirtyFiles)}`}
        </span>
        <span className="shrink-0 truncate text-caption text-faint-foreground">{p.treePath ? tildify(p.treePath) : ""}</span>
      </div>
    )
  }
  return (
    <div style={style} className={cn(base, tone, p.dim && "opacity-35")} onClick={() => p.onSelect(p.item)}>
      <Lanes row={r} width={p.width} isHead={p.isHead} isWorktree={false} />
      <RefPills labels={p.labels ?? []} trunk={p.trunk} />
      <span className={cn("min-w-0 flex-1 truncate", r.parents.length > 1 && "text-muted-foreground")}>
        <Highlight text={r.subject} query={p.query} />
      </span>
      <span className="shrink-0 font-mono text-caption text-faint-foreground @max-[470px]:hidden">{shortHash(r.id)}</span>
      <span className="w-[64px] shrink-0 truncate text-caption text-faint-foreground @max-[560px]:hidden">{r.author}</span>
      <span className="w-[52px] shrink-0 text-right text-caption tabular text-faint-foreground" title={absoluteTime(r.time)}>
        {relativeTime(r.time)}
      </span>
    </div>
  )
})

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const i = text.toLowerCase().indexOf(query)
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-xs bg-warning-subtle text-foreground">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

/** Local and remote branches on the same commit merge into one pill: `main · origin`. */
export function RefPills({ labels, trunk, max = 3 }: { labels: RefLabel[]; trunk: Trunk | null; max?: number }) {
  if (!labels.length) return null
  const branches = labels.filter((l) => l.kind === "branch")
  const remotes = labels.filter((l) => l.kind === "remote")
  const tags = labels.filter((l) => l.kind === "tag")
  const pills: { name: string; remote?: string; kind: RefLabel["kind"] }[] = []
  const used = new Set<string>()
  for (const b of branches) {
    const twins = remotes.filter((r) => r.name.endsWith(`/${b.name}`))
    twins.forEach((t) => used.add(t.name))
    pills.push({ name: b.name, remote: twins.map((t) => t.name.split("/")[0]).join(", ") || undefined, kind: "branch" })
  }
  remotes.filter((r) => !used.has(r.name)).forEach((r) => pills.push({ name: r.name, kind: "remote" }))
  tags.forEach((t) => pills.push({ name: t.name, kind: "tag" }))
  const shown = pills.slice(0, max)
  return (
    <span className="flex max-w-[45%] shrink-0 items-center gap-1 overflow-hidden">
      {shown.map((p) => (
        <span
          key={p.kind + p.name}
          className={cn(
            "inline-flex h-[18px] max-w-[200px] items-center gap-1 truncate rounded-xs px-1.5 text-caption font-medium",
            p.kind === "tag" ? "text-muted-foreground ring-1 ring-border ring-inset" : "bg-muted text-foreground",
            p.kind === "remote" && "font-normal text-muted-foreground",
            trunk && p.kind === "branch" && p.name === trunk.name && "bg-primary-subtle text-primary",
          )}
        >
          {p.kind === "tag" && <Tag className="size-3 shrink-0" />}
          <span className="truncate">{p.name}</span>
          {p.remote && <span className="font-normal opacity-75">· {p.remote}</span>}
        </span>
      ))}
      {pills.length > max && <span className="text-caption text-faint-foreground">+{pills.length - max}</span>}
    </span>
  )
}
