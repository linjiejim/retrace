import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, List, ListTree, Search, X } from "lucide-react"
import { openFile, openPreview } from "@/lib/commands"
import { shortHash, tildify } from "@/lib/format"
import { keyNav } from "@/lib/keys"
import { prefs, ui, useStore } from "@/lib/store"
import { buildTree, folderPaths, STATUS_LABEL, STATUS_LETTER, visibleRows, type Pathed, type VisibleRow } from "@/lib/tree"
import type { FileChange, Target } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { targetKey, useChanges, useFiles } from "@/hooks/queries"
import { targetOf, useProjectView } from "@/hooks/use-project-view"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"
import { IconButton } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { StateView } from "@/components/ui/state"
import { Tooltip } from "@/components/ui/tooltip"
import { PanelHeader } from "@/components/layout/LayoutView"
import { FileIcon, FolderIcon } from "./FileIcon"

export const STATUS_TONE: Record<FileChange["status"], string> = {
  added: "text-success",
  untracked: "text-success",
  modified: "text-muted-foreground",
  typechange: "text-muted-foreground",
  deleted: "text-destructive",
  renamed: "text-info",
  copied: "text-info",
  conflicted: "text-warning",
}

/** A file in the files view, with its change when the selected version touched it. */
interface FileItem extends Pathed {
  change?: FileChange
}

export function ChangesPanel() {
  const { projectId, tab, trunk } = useProjectView()
  const selection = useStore(ui, (s) => s.selection)
  const file = useStore(ui, (s) => s.file)
  const mode = useStore(prefs, (s) => s.changesMode)
  const target = targetOf(selection, tab, trunk)
  const changes = useChanges(projectId, target)

  // Keep the open file when the next commit touches it too; otherwise clear it.
  useEffect(() => {
    if (file && changes.data && !changes.data.some((f) => f.path === file.path)) ui.set({ file: null })
  }, [file, changes.data])

  return (
    <section className="flex h-full min-w-0 flex-col">
      <PanelHeader>
        <Segmented
          size="sm"
          aria-label={t("Changes or all files")}
          value={mode}
          onValueChange={(v) => prefs.set({ changesMode: v })}
          options={[
            { value: "files", label: t("Files") },
            { value: "changes", label: t("Changes") },
          ]}
        />
        <span data-tauri-drag-region className="h-full flex-1" />
      </PanelHeader>
      {!projectId || !tab || !target ? (
        <div className="px-3 py-3 text-caption text-faint-foreground">{t("Pick a commit to see the files it changed.")}</div>
      ) : mode === "files" ? (
        <FilesView key={projectId} projectId={projectId} target={target} changes={changes.data} headLabel={tab.label} />
      ) : changes.isError ? (
        <StateView size="sm" kind="error" description={changes.error.message} onRetry={() => changes.refetch()} />
      ) : !changes.data ? (
        <ListSkeleton />
      ) : changes.data.length === 0 ? (
        <div className="px-3 py-3 text-caption text-faint-foreground">{t("No file changes.")}</div>
      ) : (
        <ChangesList key={`${projectId}:${targetKey(target)}`} files={changes.data} />
      )}
    </section>
  )
}

function ListSkeleton() {
  const shown = useDelayedFlag(true)
  if (!shown) return null
  return (
    <div className="px-3 pt-1">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex h-[26px] items-center gap-2">
          <Skeleton className="size-3.5" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** The row under the header: a summary or filter on the left, folding and display toggles on the right. */
function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex h-8 shrink-0 items-center gap-1 border-b pl-3 pr-2 text-caption text-muted-foreground">{children}</div>
}

function FoldButton({ allClosed, onFold }: { allClosed: boolean; onFold: (open: boolean) => void }) {
  return (
    <IconButton label={allClosed ? t("Expand all") : t("Collapse all")} size="icon-sm" onClick={() => onFold(allClosed)}>
      {allClosed ? <ChevronsUpDown /> : <ChevronsDownUp />}
    </IconButton>
  )
}

/** ↑↓ walk the visible files; → from the graph enters the list and opens the diff. */
function useFileNav(paths: string[], current: string | null, open: (path: string) => void) {
  // The diff panel steps through files in the order shown here.
  useEffect(() => {
    ui.set({ fileOrder: paths })
  }, [paths])
  const latest = useRef({ paths, current, open })
  latest.current = { paths, current, open }
  // Registered in an effect, so a list being replaced (its cleanup runs after the new list renders)
  // can't remove the new list's handlers; each cleanup only removes its own.
  useEffect(() => {
    const step = (dir: 1 | -1) => {
      const { paths, current, open } = latest.current
      if (!paths.length) return
      const i = current ? paths.indexOf(current) : -1
      open(paths[i < 0 ? 0 : Math.max(0, Math.min(paths.length - 1, i + dir))])
    }
    const enter = () => {
      ui.set({ focusArea: "changes", diffOpen: true })
      if (!latest.current.current) step(1)
    }
    keyNav.changes = step
    keyNav.enterChanges = enter
    return () => {
      if (keyNav.changes === step) keyNav.changes = undefined
      if (keyNav.enterChanges === enter) keyNav.enterChanges = undefined
      // An empty or loading list must not keep the previous list's order.
      ui.set({ fileOrder: [] })
    }
  }, [])
}

// ---------- changes ----------

function ChangesList({ files }: { files: FileChange[] }) {
  const listMode = useStore(prefs, (s) => s.listMode)
  const diffView = useStore(prefs, (s) => s.diffView)
  const diffOpen = useStore(ui, (s) => s.diffOpen)
  const current = useStore(ui, (s) => s.file)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildTree(files), [files])
  const folders = useMemo(() => folderPaths(tree), [tree])
  const rows: VisibleRow[] = useMemo(() => {
    if (listMode === "list") {
      return [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ node: { kind: "file", name: file.path.split("/").pop() ?? file.path, file }, depth: 0 }))
    }
    return visibleRows(tree, (p) => !collapsed.has(p))
  }, [files, tree, listMode, collapsed])
  const paths = useMemo(() => rows.flatMap((r) => (r.node.kind === "file" ? [r.node.file.path] : [])), [rows])
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  const open = (path: string) => {
    const f = byPath.get(path)
    if (f) openFile({ path: f.path, oldPath: f.oldPath })
  }
  useFileNav(paths, current?.path ?? null, open)

  // An open diff always shows a file: the first one until another is picked.
  useEffect(() => {
    if (!diffOpen || diffView !== "file" || current || !paths[0]) return
    const f = byPath.get(paths[0])
    if (f) ui.set({ file: { path: f.path, oldPath: f.oldPath } })
  }, [diffOpen, diffView, current, paths, byPath])

  const totals = useMemo(() => {
    // Huge commits come without line counts; don't show a misleading +0 −0.
    if (files.some((f) => !f.binary && f.additions == null)) return null
    return files.reduce((acc, f) => ({ a: acc.a + (f.additions ?? 0), d: acc.d + (f.deletions ?? 0) }), { a: 0, d: 0 })
  }, [files])
  const allClosed = folders.length > 0 && folders.every((p) => collapsed.has(p))

  return (
    <>
      <Toolbar>
        <span className="min-w-0 flex-1 truncate tabular">
          {tp("{n} file", "{n} files", files.length)}
          {totals && (
            <>
              <span className="ml-2 text-success">+{totals.a}</span>
              <span className="ml-1.5 text-destructive">−{totals.d}</span>
            </>
          )}
        </span>
        {listMode === "tree" && folders.length > 0 && <FoldButton allClosed={allClosed} onFold={(o) => setCollapsed(o ? new Set() : new Set(folders))} />}
        <Segmented
          size="sm"
          aria-label={t("Show changes as")}
          value={listMode}
          onValueChange={(v) => prefs.set({ listMode: v })}
          options={[
            { value: "tree", label: <span className="sr-only">{t("Tree")}</span>, icon: <ListTree /> },
            { value: "list", label: <span className="sr-only">{t("List")}</span>, icon: <List /> },
          ]}
        />
      </Toolbar>
      <TreeRows
        rows={rows}
        selected={current?.path ?? null}
        isOpen={(p) => !collapsed.has(p)}
        onFolder={(p) => setCollapsed((prev) => toggled(prev, p))}
        onFile={(f) => open(f.path)}
        tip={(f) => `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path} · ${t(STATUS_LABEL[f.status])}`}
        renderName={(f, name) => {
          const dir = f.path.split("/").slice(0, -1).join("/")
          return (
            <>
              {name}
              {listMode === "list" && dir && <span className="ml-1.5 text-caption text-faint-foreground">{dir}</span>}
            </>
          )
        }}
        renderEnd={(f) => (
          <>
            <span className="flex shrink-0 gap-1.5 text-caption tabular">
              {f.binary ? (
                <span className="text-faint-foreground">{t("Binary")}</span>
              ) : (
                <>
                  {!!f.additions && <span className="text-success">+{f.additions}</span>}
                  {!!f.deletions && <span className="text-destructive">−{f.deletions}</span>}
                </>
              )}
            </span>
            <StatusLetter status={f.status} />
          </>
        )}
      />
    </>
  )
}

function toggled(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function StatusLetter({ status }: { status: FileChange["status"] }) {
  return <span className={cn("w-3.5 shrink-0 text-center font-mono text-caption font-semibold", STATUS_TONE[status])}>{STATUS_LETTER[status]}</span>
}

// ---------- files ----------

const README = /^readme(\.(md|markdown|txt|rst))?$/i

/** Every file in the selected version: on disk for uncommitted work, the commit's tree for a commit. */
function FilesView({ projectId, target, changes, headLabel }: { projectId: string; target: Target; changes: FileChange[] | undefined; headLabel: string }) {
  const files = useFiles(projectId, target, true)
  const preview = useStore(ui, (s) => s.preview)
  const diffOpen = useStore(ui, (s) => s.diffOpen)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const q = query.trim().toLowerCase()
  const byPath = useMemo(() => new Map((changes ?? []).map((c) => [c.path, c])), [changes])
  const items: FileItem[] = useMemo(() => {
    const paths = files.data?.paths ?? []
    return (q ? paths.filter((p) => p.toLowerCase().includes(q)) : paths).map((path) => ({ path, change: byPath.get(path) }))
  }, [files.data, q, byPath])
  const tree = useMemo(() => (q ? [] : buildTree(items)), [items, q])
  const folders = useMemo(() => folderPaths(tree), [tree])
  const isOpen = (p: string) => expanded.has(p)
  // Filtering turns the tree into a flat list of matches, each with its folder.
  const rows: VisibleRow<FileItem>[] = useMemo(
    () => (q ? items.map((file) => ({ node: { kind: "file", name: file.path.split("/").pop() ?? file.path, file }, depth: 0 })) : visibleRows(tree, (p) => expanded.has(p))),
    [items, tree, q, expanded],
  )
  const paths = useMemo(() => rows.flatMap((r) => (r.node.kind === "file" ? [r.node.file.path] : [])), [rows])
  useFileNav(paths, preview, openPreview)

  // Opening the preview with nothing picked shows the README, like a repository's front page.
  useEffect(() => {
    if (!diffOpen || preview || !files.data) return
    const readme = files.data.paths.find((p) => !p.includes("/") && README.test(p))
    if (readme) ui.set({ preview: readme })
  }, [diffOpen, preview, files.data])

  // Reveal the previewed file: open its folders.
  useEffect(() => {
    if (!preview || !preview.includes("/")) return
    const parts = preview.split("/").slice(0, -1)
    setExpanded((prev) => {
      const next = new Set(prev)
      parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/")))
      return next.size === prev.size ? prev : next
    })
  }, [preview])

  const version =
    target.kind === "worktree"
      ? { label: t("Disk"), tip: t("Files on disk in {path} (with uncommitted changes)", { path: tildify(target.tree) }) }
      : target.kind === "commit"
        ? { label: shortHash(target.hash), tip: t("Files as of commit {hash}", { hash: shortHash(target.hash) }) }
        : { label: shortHash(target.tip), tip: t("Files at {branch}'s latest commit {hash}", { branch: headLabel, hash: shortHash(target.tip) }) }

  return (
    <>
      <Toolbar>
        <label className="-ml-1.5 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-background px-2 text-faint-foreground ring-1 ring-border focus-within:ring-ring">
          <Search className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))}
            placeholder={t("Filter files")}
            className="w-full min-w-0 bg-transparent text-caption text-foreground outline-none placeholder:text-faint-foreground"
          />
          {query ? (
            <button aria-label={t("Clear filter")} onClick={() => setQuery("")} className="hover:text-foreground">
              <X className="size-3.5" />
            </button>
          ) : (
            <Tooltip content={version.tip}>
              <span className="shrink-0 font-mono text-caption">{version.label}</span>
            </Tooltip>
          )}
        </label>
        {!q && folders.length > 0 && <FoldButton allClosed={expanded.size === 0} onFold={(o) => setExpanded(o ? new Set(folders) : new Set())} />}
      </Toolbar>
      {files.isError ? (
        <StateView size="sm" kind="error" description={files.error.message} onRetry={() => files.refetch()} />
      ) : !files.data ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <div className="px-3 py-3 text-caption text-faint-foreground">{q ? t("No matching files") : t("No files in this version.")}</div>
      ) : (
        <TreeRows
          rows={rows}
          selected={preview}
          isOpen={isOpen}
          onFolder={(p) => setExpanded((prev) => toggled(prev, p))}
          onFile={(f) => openPreview(f.path)}
          tip={(f) => (f.change ? `${f.path} · ${t("{status} in this version", { status: t(STATUS_LABEL[f.change.status]) })}` : f.path)}
          renderName={(f, name) => {
            const dir = f.path.slice(0, -name.length - 1)
            return (
              <>
                {name}
                {q && dir && <span className="ml-1.5 text-caption text-faint-foreground">{dir}</span>}
              </>
            )
          }}
          renderEnd={(f) => (f.change ? <StatusLetter status={f.change.status} /> : null)}
          footer={files.data.truncated ? t("Only the first {n} files are listed", { n: files.data.paths.length }) : undefined}
        />
      )}
    </>
  )
}

// ---------- rows ----------

function TreeRows<T extends Pathed>({
  rows,
  selected,
  isOpen,
  onFolder,
  onFile,
  tip,
  renderName,
  renderEnd,
  footer,
}: {
  rows: VisibleRow<T>[]
  selected: string | null
  isOpen: (path: string) => boolean
  onFolder: (path: string) => void
  onFile: (file: T) => void
  tip: (file: T) => string
  renderName: (file: T, name: string) => React.ReactNode
  renderEnd: (file: T) => React.ReactNode
  footer?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const icons = useStore(prefs, (s) => s.fileIcons)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 26, overscan: 20 })

  // Keep the current file in view when the keyboard or the diff moves it.
  useEffect(() => {
    if (!selected) return
    const i = rows.findIndex((r) => r.node.kind === "file" && r.node.file.path === selected)
    if (i >= 0) v.scrollToIndex(i, { align: "auto" })
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={scroller} onMouseDown={() => ui.set({ focusArea: "changes" })} className="min-h-0 flex-1 overflow-y-auto pb-2">
      <div className="relative" style={{ height: v.getTotalSize() + (footer ? 28 : 0) }}>
        {v.getVirtualItems().map((vi) => {
          const { node, depth } = rows[vi.index]
          const style = { transform: `translateY(${vi.start}px)`, paddingLeft: 12 + depth * 14 }
          const base = "absolute inset-x-0 top-0 flex h-[26px] items-center gap-1.5 whitespace-nowrap pr-3 text-small"
          if (node.kind === "folder") {
            return (
              <div key={"d:" + node.path} style={style} className={cn(base, "text-muted-foreground hover:bg-accent")} onClick={() => onFolder(node.path)}>
                <ChevronRight className={cn("size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)", isOpen(node.path) && "rotate-90")} />
                <FolderIcon name={node.name} open={isOpen(node.path)} theme={icons} />
                <span className="min-w-0 truncate">{node.name}</span>
              </div>
            )
          }
          const f = node.file
          return (
            <Tooltip key={"f:" + f.path} content={tip(f)} side="right" delayDuration={900}>
              <div style={style} className={cn(base, selected === f.path ? "bg-selected" : "hover:bg-accent")} onClick={() => onFile(f)}>
                <span className="w-3.5 shrink-0" />
                <FileIcon path={f.path} theme={icons} />
                <span className="min-w-0 flex-1 truncate">{renderName(f, node.name)}</span>
                {renderEnd(f)}
              </div>
            </Tooltip>
          )
        })}
        {footer && (
          <div className="absolute inset-x-0 px-3 text-caption text-faint-foreground" style={{ top: v.getTotalSize() + 6 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
