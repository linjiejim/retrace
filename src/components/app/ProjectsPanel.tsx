import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Code, Ellipsis, ExternalLink, FolderOpen, GitBranch, PanelLeftClose, Plus, Search, SquareTerminal, X } from "lucide-react"
import { api } from "@/lib/api"
import { openLink, run, selectProject } from "@/lib/commands"
import { prefs, ui, useStore } from "@/lib/store"
import { ago, tildify } from "@/lib/format"
import type { Project } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { useProjects, useSummary } from "@/hooks/queries"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"
import { Button, IconButton } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { StateView } from "@/components/ui/state"
import { Skeleton } from "@/components/ui/skeleton"
import { notify } from "@/components/ui/toast"
import { PanelHeader } from "@/components/layout/LayoutView"

const ROW = 28

export function ProjectsPanel() {
  const qc = useQueryClient()
  const projects = useProjects()
  const selected = useStore(ui, (s) => s.projectId)
  const [filter, setFilter] = useState("")
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const showSkeleton = useDelayedFlag(projects.isLoading)
  const all = projects.data ?? []
  const visible = all.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))

  const select = selectProject
  const startAdd = () => run("addProject")

  async function remove(p: Project) {
    await api.removeProject(p.id)
    await qc.invalidateQueries({ queryKey: ["projects"] })
    if (selected === p.id) ui.set({ projectId: null, selection: null, file: null, preview: null, diffOpen: false })
    notify.undo(t("Removed {name} from the list", { name: p.name }), async () => {
      await api.addProjects([p.id])
      qc.invalidateQueries({ queryKey: ["projects"] })
    })
  }

  // Drag to reorder: a press that moves more than 4px becomes a drag; otherwise it's a click.
  function pressRow(e: React.PointerEvent, index: number, id: string) {
    if (e.button !== 0) return
    // Filtered lists don't reorder; a press just selects.
    if (filter) return select(id)
    const startY = e.clientY
    let dragging = false
    const indexAt = (y: number) => {
      const top = list.current?.getBoundingClientRect().top ?? 0
      const scroll = list.current?.scrollTop ?? 0
      return Math.max(0, Math.min(all.length, Math.round((y - top + scroll - 2) / ROW)))
    }
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) < 4) return
      dragging = true
      setDrag({ from: index, over: indexAt(ev.clientY) })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setDrag(null)
      if (!dragging) return select(id)
      const to = indexAt(ev.clientY)
      if (to === index || to === index + 1) return
      const order = [...all]
      const [moved] = order.splice(index, 1)
      order.splice(to > index ? to - 1 : to, 0, moved)
      qc.setQueryData(["projects"], order)
      api.reorderProjects(order.map((p) => p.id)).catch((err) => {
        notify.error(t("Couldn't save the order: {reason}", { reason: err instanceof Error ? err.message : String(err) }))
        qc.invalidateQueries({ queryKey: ["projects"] })
      })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  return (
    <section className="flex h-full flex-col bg-sunken">
      <PanelHeader>
        <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">{t("Projects")}</span>
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
        {projects.data?.length === 0 && (
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
        {projects.data && projects.data.length > 0 && visible.length === 0 && <li className="px-2 py-3 text-caption text-faint-foreground">{t("No matching projects")}</li>}
        {visible.map((p) => {
          const index = all.indexOf(p)
          return (
            <ProjectRow
              key={p.id}
              project={p}
              selected={p.id === selected}
              lifted={drag?.from === index}
              onPress={(e) => pressRow(e, index, p.id)}
              onRemove={() => remove(p)}
            />
          )
        })}
        {drag && <li aria-hidden className="pointer-events-none absolute inset-x-3 h-0.5 rounded-full bg-primary" style={{ top: drag.over * ROW - 1 }} />}
      </ul>

    </section>
  )
}

function ProjectRow({
  project,
  selected,
  lifted,
  onPress,
  onRemove,
}: {
  project: Project
  selected: boolean
  lifted: boolean
  onPress: (e: React.PointerEvent) => void
  onRemove: () => void
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
  const open = (how: "finder" | "terminal" | "editor") =>
    api.open(project.id, project.id, how).catch((e) => notify.error(String(e instanceof Error ? e.message : e)))

  return (
    <li
      className={cn(
        "group flex h-7 select-none items-center gap-1.5 rounded-sm pl-2 pr-1 text-small text-muted-foreground hover:bg-accent",
        selected && "bg-pressed font-medium text-foreground hover:bg-pressed",
        s?.missing && "text-faint-foreground line-through",
        lifted && "opacity-50",
      )}
      onPointerDown={onPress}
    >
      <Tooltip content={<span className="whitespace-pre-line">{tip}</span>} side="right" delayDuration={700}>
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
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
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => open("finder")}>
            <FolderOpen />
            {t("Open in Finder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("terminal")}>
            <SquareTerminal />
            {t("Open in Terminal")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("editor")}>
            <Code />
            {t("Open in Editor")}
          </DropdownMenuItem>
          {webUrl && (
            <DropdownMenuItem onSelect={() => openLink(webUrl)}>
              <ExternalLink />
              {t("Open on GitHub")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove}>{t("Remove from list")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
