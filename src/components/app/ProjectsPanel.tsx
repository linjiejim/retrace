import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Check, ChevronRight, Code, Ellipsis, ExternalLink, FolderInput, FolderMinus, FolderOpen, FolderPlus, GitBranch, PanelLeftClose, Pencil, Pin, PinOff, Plus, Search, SquareTerminal, Trash2, X } from "lucide-react"
import { api } from "@/lib/api"
import { openLink, run, selectProject } from "@/lib/commands"
import { PINNED, buildRows, dropTarget, groupGaps, moveGroup, moveProject, sections, type DropTarget, type GroupGap, type Row } from "@/lib/groups"
import { prefs, ui, useStore } from "@/lib/store"
import { ago, tildify } from "@/lib/format"
import type { Group, Project } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { s as kit } from "@/lib/strings"
import { useGroups, useProjects, useSummary } from "@/hooks/queries"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"
import { Button, IconButton } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tooltip } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, dropdownMenuParts, type MenuParts } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, contextMenuParts } from "@/components/ui/context-menu"
import { StateView } from "@/components/ui/state"
import { Skeleton } from "@/components/ui/skeleton"
import { notify } from "@/components/ui/toast"
import { PanelHeader } from "@/components/layout/LayoutView"

const ROW = 28
/** Left padding of a project inside a group: its name lines up with the group's. */
const NESTED = 24
const NO_GROUPS: Group[] = []

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Drag {
  id: string
  gap: number
  target: DropTarget
  /** Dropping onto this group's header: into the group, at the end. */
  onHeader: string | null
}

export function ProjectsPanel() {
  const qc = useQueryClient()
  const projects = useProjects()
  const groupsQuery = useGroups()
  const groups = groupsQuery.data ?? NO_GROUPS
  const selected = useStore(ui, (s) => s.projectId)
  const collapsedList = useStore(prefs, (s) => s.collapsedGroups)
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList])
  const [filter, setFilter] = useState("")
  const [drag, setDrag] = useState<Drag | null>(null)
  /** A group being dragged, and the gap it would land in. */
  const [groupDrag, setGroupDrag] = useState<{ id: string; gap: GroupGap } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  /** The new-group dialog is open, for these projects. */
  const [naming, setNaming] = useState<string[] | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const showSkeleton = useDelayedFlag(projects.isLoading)
  const all = useMemo(() => projects.data ?? [], [projects.data])
  const rows: Row[] = useMemo(() => {
    if (filter) {
      const q = filter.toLowerCase()
      return all.filter((p) => p.name.toLowerCase().includes(q)).map((project) => ({ kind: "project", project, group: null }))
    }
    return buildRows(all, groups, collapsed)
  }, [all, groups, collapsed, filter])
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])
  const projectCount = rows.filter((r) => r.kind === "project").length

  const startAdd = () => run("addProject")
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["projects"] }), qc.invalidateQueries({ queryKey: ["groups"] })])
  const fail = (say: (reason: string) => string) => (e: unknown) => {
    notify.error(say(message(e)))
    refresh()
  }

  async function remove(p: Project) {
    await api.removeProject(p.id)
    await qc.invalidateQueries({ queryKey: ["projects"] })
    if (selected === p.id) ui.set({ projectId: null, selection: null, file: null, preview: null, historyFile: null, diffOpen: false })
    notify.undo(t("Removed {name} from the list", { name: p.name }), async () => {
      await api.addProjects([p.id])
      if (p.group && groupName.has(p.group)) await api.setProjectGroup([p.id], p.group)
      qc.invalidateQueries({ queryKey: ["projects"] })
    })
  }

  const setCollapsed = (id: string, fold: boolean) =>
    prefs.set((s) => ({ collapsedGroups: fold ? [...new Set([...s.collapsedGroups, id])] : s.collapsedGroups.filter((g) => g !== id) }))

  // A rename picked in a menu starts once the menu has closed: until then the menu holds the focus
  // and would take it back from the name field.
  const afterMenu = useRef<(() => void) | null>(null)
  const menuClosed = (e: Event) => {
    const next = afterMenu.current
    if (!next) return
    afterMenu.current = null
    e.preventDefault()
    next()
  }

  /** Ask for the new group's name in a dialog; `members` move into it once it's created. */
  function newGroup(members: string[] = [], fromMenu = false) {
    const start = () => setNaming(members)
    if (fromMenu) afterMenu.current = start
    else start()
  }

  /** Throws to the dialog, which shows the reason and stays open. */
  async function createGroup(name: string, members: string[]) {
    const g = await api.createGroup(name, members)
    // Moved into a group by hand: no longer pinned, or it wouldn't show there.
    const pinned = all.filter((p) => p.pinned && members.includes(p.id)).map((p) => p.id)
    if (pinned.length) await api.setProjectPinned(pinned, false).catch(fail((reason) => t("Couldn't unpin the project: {reason}", { reason })))
    await refresh()
    setCollapsed(g.id, false)
    setNaming(null)
  }

  async function moveTo(p: Project, group: string | null) {
    qc.setQueryData<Project[]>(["projects"], (old) => old?.map((x) => (x.id === p.id ? { ...x, group, pinned: false } : x)))
    if (group) setCollapsed(group, false)
    api.setProjectGroup([p.id], group).catch(fail((reason) => t("Couldn't move the project: {reason}", { reason })))
    if (p.pinned) api.setProjectPinned([p.id], false).catch(fail((reason) => t("Couldn't unpin the project: {reason}", { reason })))
  }

  async function setPinned(p: Project, pinned: boolean) {
    qc.setQueryData<Project[]>(["projects"], (old) => old?.map((x) => (x.id === p.id ? { ...x, pinned } : x)))
    if (pinned) setCollapsed(PINNED, false)
    api
      .setProjectPinned([p.id], pinned)
      .catch(fail((reason) => (pinned ? t("Couldn't pin the project: {reason}", { reason }) : t("Couldn't unpin the project: {reason}", { reason }))))
  }

  async function rename(g: Group, name: string) {
    setRenaming(null)
    const clean = name.trim()
    if (!clean || clean === g.name) return
    qc.setQueryData<Group[]>(["groups"], (old) => old?.map((x) => (x.id === g.id ? { ...x, name: clean } : x)))
    api.renameGroup(g.id, clean).catch(fail((reason) => t("Couldn't rename the group: {reason}", { reason })))
  }

  async function shiftGroup(g: Group, dir: -1 | 1) {
    const i = groups.findIndex((x) => x.id === g.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= groups.length) return
    const order = [...groups]
    ;[order[i], order[j]] = [order[j], order[i]]
    qc.setQueryData(["groups"], order)
    api.reorderGroups(order.map((x) => x.id)).catch(fail((reason) => t("Couldn't save the order: {reason}", { reason })))
  }

  async function deleteGroup(g: Group) {
    const index = groups.findIndex((x) => x.id === g.id)
    const members = all.filter((p) => p.group === g.id).map((p) => p.id)
    try {
      await api.deleteGroup(g.id)
      await refresh()
      setCollapsed(g.id, false)
      notify.undo(t("Deleted the group {name}; its projects are still in the list", { name: g.name }), async () => {
        await api.createGroup(g.name, members, index)
        refresh()
      })
    } catch (e) {
      fail((reason) => t("Couldn't delete the group: {reason}", { reason }))(e)
    }
  }

  // Drag to reorder (and to move between groups): a press that moves more than 4px becomes a drag;
  // otherwise it's a click. Moving the pointer right nests into a group, left takes it out.
  function pressRow(e: React.PointerEvent, p: Project) {
    if (e.button !== 0) return
    // Filtered lists don't reorder; a press just selects.
    if (filter) return selectProject(p.id)
    const startX = e.clientX
    const startY = e.clientY
    const nestedAtStart = rows.some((r) => r.kind === "project" && r.project.id === p.id && r.group !== null)
    const secs = sections(all, groups)
    let dragging = false
    const where = (ev: PointerEvent): Drag => {
      const top = list.current?.getBoundingClientRect().top ?? 0
      const y = ev.clientY - top + (list.current?.scrollTop ?? 0) - 2
      const under = rows[Math.floor(y / ROW)]
      const frac = (y % ROW) / ROW
      if (under?.kind === "group" && frac > 0.25 && frac < 0.75) {
        return { id: p.id, gap: -1, target: { group: under.group.id, before: null }, onHeader: under.group.id }
      }
      const gap = Math.max(0, Math.min(rows.length, Math.round(y / ROW)))
      const dx = ev.clientX - startX
      const indented = dx > 12 ? true : dx < -12 ? false : nestedAtStart
      return { id: p.id, gap, target: dropTarget(rows, secs, gap, indented), onHeader: null }
    }
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return
      dragging = true
      setDrag(where(ev))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setDrag(null)
      if (!dragging) return selectProject(p.id)
      const { target } = where(ev)
      const order = moveProject(secs, p.id, target)
      const home = p.group && groupName.has(p.group) ? p.group : null
      // Dropped among the pinned ones: pinned, keeping its group; anywhere else: unpinned, in that group.
      const pinned = target.group === PINNED
      const group = pinned ? home : target.group
      const regrouped = home !== group || p.pinned !== pinned
      if (!regrouped && order.every((id, i) => id === all[i]?.id)) return
      const byId = new Map(all.map((x) => [x.id, x]))
      qc.setQueryData(
        ["projects"],
        order.map((id) => (id === p.id ? { ...byId.get(id)!, group, pinned } : byId.get(id)!)),
      )
      if (target.group) setCollapsed(target.group, false)
      api.reorderProjects(order, regrouped ? { id: p.id, group, pinned } : undefined).catch(fail((reason) => t("Couldn't save the order: {reason}", { reason })))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // Drag a group's header to reorder the groups; a press that doesn't move folds or unfolds it.
  // The pinned projects always stay first.
  function pressGroup(e: React.PointerEvent, g: Group, toggle: () => void) {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const gaps = filter || g.id === PINNED || groups.length < 2 ? [] : groupGaps(rows)
    let dragging = false
    const where = (ev: PointerEvent): GroupGap => {
      const top = list.current?.getBoundingClientRect().top ?? 0
      const y = (ev.clientY - top + (list.current?.scrollTop ?? 0)) / ROW
      return gaps.reduce((best, gap) => (Math.abs(gap.row - y) < Math.abs(best.row - y) ? gap : best))
    }
    const move = (ev: PointerEvent) => {
      if (!gaps.length) return
      if (!dragging && Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return
      dragging = true
      setGroupDrag({ id: g.id, gap: where(ev) })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setGroupDrag(null)
      if (!dragging) return toggle()
      const before = groups.map((x) => x.id)
      const order = moveGroup(before, g.id, where(ev))
      if (order.every((id, i) => id === before[i])) return
      const byId = new Map(groups.map((x) => [x.id, x]))
      qc.setQueryData(["groups"], order.map((id) => byId.get(id)!))
      api.reorderGroups(order).catch(fail((reason) => t("Couldn't save the order: {reason}", { reason })))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  return (
    <section className="flex h-full flex-col bg-sunken">
      <PanelHeader>
        <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">{t("Projects")}</span>
        <IconButton label={t("New group")} size="icon-sm" onClick={() => newGroup()} disabled={!projects.data}>
          <FolderPlus />
        </IconButton>
        <IconButton label={t("Add a repository, or a folder of repositories")} size="icon-sm" onClick={startAdd}>
          <Plus />
        </IconButton>
        <IconButton label={`${t("Hide projects")}  ⌘\\`} size="icon-sm" onClick={() => prefs.set({ projectsCollapsed: true })}>
          <PanelLeftClose />
        </IconButton>
      </PanelHeader>
      <div className="flex shrink-0 items-center px-2 py-1.5">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-background px-2 text-faint-foreground ring-1 ring-border focus-within:ring-ring">
          <Search className="size-3.5" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("Filter projects")}
            className="w-full min-w-0 bg-transparent text-small text-foreground outline-none placeholder:text-faint-foreground"
          />
          {filter && (
            <button aria-label={t("Clear filter")} onClick={() => setFilter("")} className="text-faint-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      <ul ref={list} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {showSkeleton &&
          Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex h-7 items-center px-2">
              <Skeleton className="h-3 w-3/4" />
            </li>
          ))}
        {projects.isError && <StateView size="sm" kind="error" onRetry={() => projects.refetch()} />}
        {projects.data?.length === 0 && groups.length === 0 && (
          <StateView
            size="sm"
            kind="empty"
            title={t("No projects yet")}
            description={t("Add a repository, or a folder that holds repositories.")}
            action={
              <Button size="sm" onClick={startAdd}>
                <Plus />
                {t("Add project")}
              </Button>
            }
          />
        )}
        {filter && all.length > 0 && projectCount === 0 && <li className="px-2 py-3 text-caption text-faint-foreground">{t("No matching projects")}</li>}
        {rows.map((r) =>
          r.kind === "group" ? (
            <GroupRow
              key={"g:" + r.group.id}
              group={r.group}
              count={r.count}
              collapsed={r.collapsed}
              pinned={r.group.id === PINNED}
              holdsSelected={r.collapsed && all.some((p) => p.id === selected && (r.group.id === PINNED ? p.pinned : !p.pinned && p.group === r.group.id))}
              dropping={drag?.onHeader === r.group.id}
              lifted={groupDrag?.id === r.group.id}
              renaming={renaming === r.group.id}
              first={groups[0]?.id === r.group.id}
              last={groups[groups.length - 1]?.id === r.group.id}
              onPress={(e) => pressGroup(e, r.group, () => setCollapsed(r.group.id, !r.collapsed))}
              onRename={(name) => rename(r.group, name)}
              onStartRename={() => (afterMenu.current = () => setRenaming(r.group.id))}
              onMenuClosed={menuClosed}
              onShift={(dir) => shiftGroup(r.group, dir)}
              onDelete={() => deleteGroup(r.group)}
            />
          ) : r.kind === "empty" ? (
            <li key={"e:" + r.group} className="flex h-7 items-center truncate pr-2 text-caption text-faint-foreground" style={{ paddingLeft: NESTED }}>
              {t("Drag projects here")}
            </li>
          ) : (
            <ProjectRow
              key={r.project.id}
              project={r.project}
              nested={r.group !== null}
              groups={groups}
              groupLabel={filter && r.project.group ? groupName.get(r.project.group) : undefined}
              selected={r.project.id === selected}
              lifted={drag?.id === r.project.id}
              onPress={(e) => pressRow(e, r.project)}
              onRemove={() => remove(r.project)}
              onMove={(g) => moveTo(r.project, g)}
              onPin={(pinned) => setPinned(r.project, pinned)}
              onNewGroup={() => newGroup([r.project.id], true)}
              onMenuClosed={menuClosed}
            />
          ),
        )}
        {drag && drag.gap >= 0 && (
          <li
            aria-hidden
            className="pointer-events-none absolute right-3 h-0.5 rounded-full bg-primary"
            style={{ top: drag.gap * ROW - 1, left: drag.target.group ? NESTED + 8 : 12 }}
          />
        )}
        {groupDrag && <li aria-hidden className="pointer-events-none absolute left-3 right-3 h-0.5 rounded-full bg-primary" style={{ top: groupDrag.gap.row * ROW - 1 }} />}
      </ul>
      {naming && <NewGroupDialog onCreate={(name) => createGroup(name, naming)} onClose={() => setNaming(null)} />}
    </section>
  )
}

/** Names a new group before it's created: Enter or the button creates it, Esc cancels. */
function NewGroupDialog({ onCreate, onClose }: { onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(clean)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={t("New group")} />
        <form onSubmit={submit}>
          <DialogBody>
            <Field label={t("Group name")} error={error}>
              <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {kit().cancel}
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()} loading={busy}>
              {t("Create group")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GroupRow({
  group,
  count,
  collapsed,
  pinned,
  holdsSelected,
  dropping,
  lifted,
  renaming,
  first,
  last,
  onPress,
  onRename,
  onStartRename,
  onShift,
  onDelete,
  onMenuClosed,
}: {
  group: Group
  count: number
  collapsed: boolean
  /** The pinned projects' header: no name of its own, no menu, not draggable. */
  pinned: boolean
  /** Folded with the selected project inside. */
  holdsSelected: boolean
  dropping: boolean
  /** Being dragged. */
  lifted: boolean
  renaming: boolean
  first: boolean
  last: boolean
  /** A press: folds or unfolds it, or starts dragging it. */
  onPress: (e: React.PointerEvent) => void
  onRename: (name: string) => void
  onStartRename: () => void
  onShift: (dir: -1 | 1) => void
  onDelete: () => void
  onMenuClosed: (e: Event) => void
}) {
  const menu = (k: MenuParts) => (
    <>
      <k.Item onSelect={onStartRename}>
        <Pencil />
        {t("Rename")}
      </k.Item>
      <k.Item onSelect={() => onShift(-1)} disabled={first}>
        <ArrowUp />
        {t("Move up")}
      </k.Item>
      <k.Item onSelect={() => onShift(1)} disabled={last}>
        <ArrowDown />
        {t("Move down")}
      </k.Item>
      <k.Separator />
      <k.Item onSelect={onDelete}>
        <Trash2 />
        {t("Delete group")}
      </k.Item>
    </>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={renaming || pinned}>
        <li
          className={cn(
            "group flex h-7 select-none items-center gap-1 rounded-sm pl-1.5 pr-1 text-small text-muted-foreground hover:bg-accent",
            holdsSelected && "font-medium text-foreground",
            dropping && "bg-primary-subtle ring-1 ring-primary ring-inset",
            lifted && "opacity-50",
          )}
          onPointerDown={renaming ? undefined : onPress}
          aria-expanded={!collapsed}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)", !collapsed && "rotate-90")} />
          {pinned ? (
            <>
              <Pin className="size-3 shrink-0 text-faint-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{t("Pinned")}</span>
              <span className="shrink-0 text-caption tabular text-faint-foreground">{count}</span>
            </>
          ) : renaming ? (
            <RenameInput initial={group.name} onDone={onRename} />
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
              <span className="shrink-0 text-caption tabular text-faint-foreground group-hover:hidden">{count}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={t("More actions for {name}", { name: group.name })}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    className="hidden size-5 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:bg-pressed hover:text-foreground group-hover:inline-flex data-[state=open]:inline-flex"
                  >
                    <Ellipsis className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" onCloseAutoFocus={onMenuClosed}>
                  {menu(dropdownMenuParts)}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onMenuClosed}>{menu(contextMenuParts)}</ContextMenuContent>
    </ContextMenu>
  )
}

/** Enter or leaving the field saves; Esc keeps the old name. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (name: string) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  // After a menu closes it hands focus back to its trigger; take it once that's done.
  useEffect(() => {
    const id = requestAnimationFrame(() => input.current?.select())
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <input
      ref={input}
      defaultValue={initial}
      aria-label={t("Group name")}
      maxLength={80}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") finish(e.currentTarget.value)
        if (e.key === "Escape") finish(initial)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="h-5 min-w-0 flex-1 rounded-xs bg-background px-1 text-small font-medium text-foreground outline-none ring-1 ring-ring"
    />
  )
}

function ProjectRow({
  project,
  nested,
  groups,
  groupLabel,
  selected,
  lifted,
  onPress,
  onRemove,
  onMove,
  onPin,
  onNewGroup,
  onMenuClosed,
}: {
  project: Project
  nested: boolean
  groups: Group[]
  /** Shown after the name while filtering, where groups aren't drawn. */
  groupLabel?: string
  selected: boolean
  lifted: boolean
  onPress: (e: React.PointerEvent) => void
  onRemove: () => void
  onMove: (group: string | null) => void
  onPin: (pinned: boolean) => void
  onNewGroup: () => void
  onMenuClosed: (e: Event) => void
}) {
  const summary = useSummary(project.id)
  const s = summary.data
  const webUrl = s?.webUrl
  const tip = [
    tildify(project.id),
    s?.missing ? t("Folder not found") : null,
    s?.lastCommitAt ? t("Last commit {when}", { when: ago(s.lastCommitAt) }) : null,
    s?.linkedTrees ? tp("{n} worktree", "{n} worktrees", s.linkedTrees) : null,
    s?.dirtyTrees ? tp("{n} with uncommitted changes", "{n} with uncommitted changes", s.dirtyTrees) : null,
  ]
    .filter(Boolean)
    .join("\n")
  const open = (how: "finder" | "terminal" | "editor") => api.open(project.id, project.id, how).catch((e) => notify.error(message(e)))
  const inGroup = groups.some((g) => g.id === project.group)

  const menu = (k: MenuParts) => (
    <>
      <k.Item onSelect={() => open("finder")}>
        <FolderOpen />
        {t("Open in Finder")}
      </k.Item>
      <k.Item onSelect={() => open("terminal")}>
        <SquareTerminal />
        {t("Open in Terminal")}
      </k.Item>
      <k.Item onSelect={() => open("editor")}>
        <Code />
        {t("Open in Editor")}
      </k.Item>
      {webUrl && (
        <k.Item onSelect={() => openLink(webUrl)}>
          <ExternalLink />
          {t("Open on GitHub")}
        </k.Item>
      )}
      <k.Separator />
      <k.Item onSelect={() => onPin(!project.pinned)}>
        {project.pinned ? <PinOff /> : <Pin />}
        {project.pinned ? t("Unpin") : t("Pin to top")}
      </k.Item>
      <k.Sub>
        <k.SubTrigger>
          <FolderInput />
          {t("Move to group")}
        </k.SubTrigger>
        <k.SubContent>
          {groups.map((g) => (
            // A pinned project shows only among the pinned ones: moving it to its own group unpins it.
            <k.Item key={g.id} onSelect={() => (project.pinned || g.id !== project.group) && onMove(g.id)}>
              <span className="min-w-0 flex-1 truncate">{g.name}</span>
              {g.id === project.group && <Check />}
            </k.Item>
          ))}
          {groups.length > 0 && <k.Separator />}
          <k.Item onSelect={onNewGroup}>
            <FolderPlus />
            {t("New group…")}
          </k.Item>
        </k.SubContent>
      </k.Sub>
      {inGroup && !project.pinned && (
        <k.Item onSelect={() => onMove(null)}>
          <FolderMinus />
          {t("Take out of the group")}
        </k.Item>
      )}
      <k.Separator />
      <k.Item onSelect={onRemove}>{t("Remove from list")}</k.Item>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn(
            "group flex h-7 select-none items-center gap-1.5 rounded-sm pr-1 text-small text-muted-foreground hover:bg-accent",
            !nested && "pl-2",
            selected && "bg-pressed font-medium text-foreground hover:bg-pressed",
            s?.missing && "text-faint-foreground line-through",
            lifted && "opacity-50",
          )}
          style={nested ? { paddingLeft: NESTED } : undefined}
          onPointerDown={onPress}
        >
          <Tooltip content={<span className="whitespace-pre-line">{tip}</span>} side="right" delayDuration={700}>
            <span className="min-w-0 flex-1 truncate">
              {project.name}
              {groupLabel && <span className="ml-1.5 text-caption font-normal text-faint-foreground">{groupLabel}</span>}
            </span>
          </Tooltip>
          {!!s?.linkedTrees && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-caption font-normal text-faint-foreground group-hover:hidden">
              <GitBranch className="size-3" />
              <span className="tabular">{s.linkedTrees}</span>
            </span>
          )}
          {!!s?.dirtyTrees && <span aria-label={t("Has uncommitted changes")} className="size-1.5 shrink-0 rounded-full bg-warning group-hover:hidden" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={t("More actions for {name}", { name: project.name })}
                onPointerDown={(e) => e.stopPropagation()}
                className="hidden size-5 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:bg-pressed hover:text-foreground group-hover:inline-flex data-[state=open]:inline-flex"
              >
                <Ellipsis className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={onMenuClosed}>
              {menu(dropdownMenuParts)}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onMenuClosed}>{menu(contextMenuParts)}</ContextMenuContent>
    </ContextMenu>
  )
}
