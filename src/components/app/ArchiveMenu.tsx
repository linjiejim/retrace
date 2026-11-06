import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, Clock, LoaderCircle, Pin } from "lucide-react"
import { api } from "@/lib/api"
import { ago, shortHash, tildify } from "@/lib/format"
import type { BranchStatus, CleanupCandidate } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { invalidateProject, useCleanupCandidates, type Tab } from "@/hooks/queries"
import type { useProjectView } from "@/hooks/use-project-view"
import { Button, IconButton } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip } from "@/components/ui/tooltip"
import { notify } from "@/components/ui/toast"

type Result = { state: "running" } | { state: "removed"; note: string | null } | { state: "skipped"; reason: string }

const treeItem = (path: string) => `tree:${path}`
const branchItem = (name: string) => `branch:${name}`

/**
 * Worktrees and local branches already in the trunk, folded next to the main tree: view one, or
 * remove them. `children` is the trigger.
 */
export function ArchiveMenu({
  view,
  archived,
  branches,
  onOpen,
  onOpenBranch,
  children,
}: {
  view: ReturnType<typeof useProjectView>
  archived: Tab[]
  /** Merged branches without a worktree that may be deleted (not protected, not kept). */
  branches: BranchStatus[]
  onOpen: (t: Tab) => void
  onOpenBranch: (name: string) => void
  children: React.ReactNode
}) {
  const qc = useQueryClient()
  const { projectId, trunk } = view
  const [open, setOpen] = useState(false)
  const candidates = useCleanupCandidates(projectId, open)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [confirming, setConfirming] = useState(false)
  /** What the confirmation is about: frozen when it opens, so a refresh can't change it. */
  const [pending, setPending] = useState<{ trees: CleanupCandidate[]; branches: BranchStatus[] }>({ trees: [], branches: [] })
  const [results, setResults] = useState<Record<string, Result>>({})
  const byPath = useMemo(() => new Map((candidates.data ?? []).map((c) => [c.path, c])), [candidates.data])
  const byName = useMemo(() => new Map(branches.map((b) => [b.name, b])), [branches])

  // Opening checks the branches again too; the worktrees are checked by `candidates`.
  useEffect(() => {
    if (open && projectId) qc.invalidateQueries({ queryKey: ["branches", projectId] })
  }, [open, projectId, qc])

  // Each ticked item remembers the warnings it was ticked under. Ticks are set once per opening
  // (safe items only); a refresh drops items that stopped qualifying and un-ticks any item whose
  // warnings changed since, so a new .env, fresh activity or a moved branch always needs a new,
  // explicit tick.
  const seen = useRef(new Map<string, string>())
  const initialized = useRef(false)
  const treeWarnings = (c: CleanupCandidate) => JSON.stringify([c.notableIgnored, c.recent])
  const branchWarnings = (b: BranchStatus) => JSON.stringify([b.recent, b.tip])
  useEffect(() => {
    if (!open) {
      setResults({})
      initialized.current = false
      return
    }
    if (!candidates.data) return
    const now = new Map([
      ...candidates.data.map((c) => [treeItem(c.path), treeWarnings(c)] as const),
      ...branches.map((b) => [branchItem(b.name), branchWarnings(b)] as const),
    ])
    if (!initialized.current) {
      initialized.current = true
      const safe = [
        ...candidates.data.filter((c) => c.notableIgnored.length === 0 && !c.recent).map((c) => treeItem(c.path)),
        ...branches.filter((b) => !b.recent).map((b) => branchItem(b.name)),
      ]
      seen.current = new Map(safe.map((k) => [k, now.get(k)!]))
      setChecked(new Set(safe))
      return
    }
    setChecked((prev) => new Set([...prev].filter((k) => now.has(k) && now.get(k) === seen.current.get(k))))
  }, [open, candidates.data, branches])

  const toggle = (key: string, warnings: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else {
        next.add(key)
        seen.current.set(key, warnings)
      }
      return next
    })

  const checkedTrees = [...checked].flatMap((k) => (k.startsWith("tree:") ? [byPath.get(k.slice(5))] : [])).filter((c): c is CleanupCandidate => !!c)
  const checkedBranches = [...checked].flatMap((k) => (k.startsWith("branch:") ? [byName.get(k.slice(7))] : [])).filter((b): b is BranchStatus => !!b)
  const count = checkedTrees.length + checkedBranches.length

  const confirm = () => {
    setPending({ trees: checkedTrees, branches: checkedBranches })
    setConfirming(true)
  }

  const restore = async (id: string, names: string[]) => {
    const failed: string[] = []
    const settings: string[] = []
    for (const name of names) {
      try {
        settings.push(...(await api.restoreBranch(id, name)).settingsFailed)
      } catch (e) {
        failed.push(`${name}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    invalidateProject(qc, id, { git: true, trees: [] })
    if (failed.length) notify.error(t("Couldn't restore {n} of the branches ({first})", { n: failed.length, first: failed[0] }))
    if (settings.length) notify.warning(t("Restored the branches, but not these settings: {keys}", { keys: settings.join(", ") }))
    if (!failed.length && !settings.length) notify.success(tp("Restored {n} branch", "Restored {n} branches", names.length))
  }

  const removeChecked = async () => {
    const id = projectId!
    let removed = 0
    /** Every branch deleted here, with a worktree or without: Undo brings them all back. */
    const deleted: string[] = []
    const skipped: string[] = []
    let branchesDeleted = 0
    const fail = (key: string, label: string, e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e)
      setResults((r) => ({ ...r, [key]: { state: "skipped", reason } }))
      skipped.push(`${label}：${reason}`)
    }
    for (const c of pending.trees) {
      const key = treeItem(c.path)
      setResults((r) => ({ ...r, [key]: { state: "running" } }))
      try {
        const out = await api.removeWorktree(id, c.path, c.head, c.notableIgnored, deleteBranch)
        const note = out.deletedBranch ? t("Deleted branch {name}", { name: out.deletedBranch }) : out.branchKeptReason
        setResults((r) => ({ ...r, [key]: { state: "removed", note } }))
        removed++
        if (out.deletedBranch) deleted.push(out.deletedBranch)
      } catch (e) {
        fail(key, c.branch ?? c.path, e)
      }
    }
    for (const b of pending.branches) {
      const key = branchItem(b.name)
      setResults((r) => ({ ...r, [key]: { state: "running" } }))
      try {
        await api.deleteBranch(id, b.name, b.tip)
        setResults((r) => ({ ...r, [key]: { state: "removed", note: null } }))
        deleted.push(b.name)
        branchesDeleted++
      } catch (e) {
        fail(key, b.name, e)
      }
    }
    setChecked(new Set())
    invalidateProject(qc, id, { git: true, trees: [] })
    // The menu disappears once nothing is left in it, so say what happened.
    if (skipped.length) notify.warning(t("Removed {removed}, skipped {skipped} ({first})", { removed: removed + branchesDeleted, skipped: skipped.length, first: skipped[0] }))
    else if (removed) notify.success(tp("Removed {n} worktree", "Removed {n} worktrees", removed))
    if (deleted.length) notify.undo(tp("Deleted {n} branch", "Deleted {n} branches", deleted.length), () => restore(id, deleted))
  }

  const keep = async (b: BranchStatus) => {
    const id = projectId!
    try {
      await api.keepBranch(id, b.name, true)
      qc.invalidateQueries({ queryKey: ["branches", id] })
      notify.undo(t("Keeping {name}: it moves to Branches", { name: b.name }), async () => {
        try {
          await api.keepBranch(id, b.name, false)
          qc.invalidateQueries({ queryKey: ["branches", id] })
        } catch (e) {
          notify.error(e instanceof Error ? e.message : String(e))
        }
      })
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e))
    }
  }

  const done = Object.values(results).filter((r) => r.state === "removed").length
  const running = Object.values(results).some((r) => r.state === "running")
  const both = archived.length > 0 && branches.length > 0
  const trunkName = trunk?.name ?? t("the trunk")

  const label = !count
    ? t("Remove")
    : checkedTrees.length && checkedBranches.length
      ? tp("Remove {n} item", "Remove {n} items", count)
      : checkedTrees.length
        ? tp("Remove {n} worktree", "Remove {n} worktrees", count)
        : tp("Delete {n} branch", "Delete {n} branches", count)
  const nTrees = pending.trees.length
  const nBranches = pending.branches.length
  const title =
    nTrees && nBranches
      ? tp("Remove {n} item?", "Remove {n} items?", nTrees + nBranches)
      : nTrees
        ? tp("Remove {n} worktree?", "Remove {n} worktrees?", nTrees)
        : tp("Delete {n} branch?", "Delete {n} branches?", nBranches)
  const description =
    nTrees && nBranches
      ? t("Deletes the folders (no --force; ignored files in them go too) and the branches, each checked again first. Deleted branches can be restored right after.")
      : nTrees
        ? deleteBranch
          ? t("Deletes these folders and their merged local branches, each checked again first (no --force). Ignored files in them are deleted too.")
          : t("Deletes these folders, each checked again first (no --force). Ignored files in them are deleted too.")
        : t("Each is checked again and deleted only if it still points at the commit shown. Its commits stay in {trunk}; you can restore it right after.", { trunk: trunkName })

  const mark = (r: Result | undefined, box: React.ReactNode) =>
    r?.state === "running" ? (
      <Spinner className="size-4" />
    ) : r?.state === "removed" ? (
      <CircleCheck className="size-4 text-success" />
    ) : r?.state === "skipped" ? (
      <CircleAlert className="size-4 text-destructive" />
    ) : (
      box
    )

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent className="w-[440px] p-0" align="start">
          <div className="px-3 pb-1 pt-2.5 text-caption text-faint-foreground">{t("Already in {trunk}: safe to remove", { trunk: trunkName })}</div>
          <div className="max-h-[50vh] overflow-y-auto px-1 pb-1">
            {archived.length > 0 && (
              <>
                {both && <div className="px-2 pb-0.5 pt-1.5 text-caption font-medium text-muted-foreground">{t("Worktrees")}</div>}
                <ul>
                  {archived.map((tab) => {
                    const c = tab.tree ? byPath.get(tab.tree.path) : undefined
                    const r = tab.tree ? results[treeItem(tab.tree.path)] : undefined
                    const integration = tab.status?.trunk?.integration
                    return (
                      <li key={tab.key} className="flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
                        <span className="pt-0.5">
                          {mark(
                            r,
                            <Checkbox
                              disabled={!c || running}
                              checked={!!c && checked.has(treeItem(c.path))}
                              onCheckedChange={() => c && toggle(treeItem(c.path), treeWarnings(c))}
                              aria-label={t("Select {name}", { name: tab.label })}
                            />,
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <button
                              disabled={r?.state === "removed"}
                              onClick={() => {
                                onOpen(tab)
                                setOpen(false)
                              }}
                              className="min-w-0 truncate text-left text-body font-medium hover:underline disabled:text-faint-foreground disabled:no-underline"
                            >
                              {tab.label}
                            </button>
                            <span className={cn("shrink-0 text-caption", integration === "squash" ? "text-info" : "text-success")}>
                              {integration === "squash" ? t("Squash-merged") : t("Merged in")}
                            </span>
                            {c?.lastCommitAt && <span className="shrink-0 text-caption text-faint-foreground">{ago(c.lastCommitAt)}</span>}
                          </div>
                          <div className="truncate text-caption text-faint-foreground">{tab.tree ? tildify(tab.tree.path) : ""}</div>
                          {r?.state === "removed" && r.note && <div className="text-caption text-muted-foreground">{r.note}</div>}
                          {r?.state === "skipped" && <div className="text-caption text-destructive">{t("Skipped: {reason}", { reason: r.reason })}</div>}
                          {!r && c && c.notableIgnored.length > 0 && (
                            <div className="text-caption text-warning">{t("Removing it also deletes ignored {files}", { files: c.notableIgnored.slice(0, 4).join(", ") + (c.notableIgnored.length > 4 ? " …" : "") })}</div>
                          )}
                          {!r && c?.recent && (
                            <div className="inline-flex items-center gap-1 text-caption text-warning">
                              <Clock className="size-3" />
                              {t("Active in the last 15 minutes; an agent may still be using it")}
                            </div>
                          )}
                          {!r && !c && candidates.isFetching && <div className="text-caption text-faint-foreground">{t("Checking again…")}</div>}
                          {!r && !c && candidates.data && <div className="text-caption text-faint-foreground">{t("No longer qualifies on a second check; can't remove")}</div>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            {branches.length > 0 && (
              <>
                {both && <div className="px-2 pb-0.5 pt-1.5 text-caption font-medium text-muted-foreground">{t("Branches without a worktree")}</div>}
                <ul>
                  {branches.map((b) => {
                    const key = branchItem(b.name)
                    const r = results[key]
                    return (
                      <li key={key} className="flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
                        <span className="pt-0.5">
                          {mark(
                            r,
                            <Checkbox disabled={running} checked={checked.has(key)} onCheckedChange={() => toggle(key, branchWarnings(b))} aria-label={t("Select {name}", { name: b.name })} />,
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <button
                              disabled={r?.state === "removed"}
                              onClick={() => {
                                onOpenBranch(b.name)
                                setOpen(false)
                              }}
                              className="min-w-0 truncate text-left text-body font-medium hover:underline disabled:text-faint-foreground disabled:no-underline"
                            >
                              {b.name}
                            </button>
                            {b.neverCommitted ? (
                              <Tooltip content={t("Created and never committed to; deleting it loses nothing")}>
                                <span className="shrink-0 text-caption text-muted-foreground">{t("No commits")}</span>
                              </Tooltip>
                            ) : (
                              <span className={cn("shrink-0 text-caption", b.integration === "squash" ? "text-info" : "text-success")}>
                                {b.integration === "squash" ? t("Squash-merged") : t("Merged in")}
                              </span>
                            )}
                            {b.lastCommitAt && <span className="shrink-0 text-caption text-faint-foreground">{ago(b.lastCommitAt)}</span>}
                          </div>
                          <div className="truncate text-caption text-faint-foreground">
                            <span className="font-mono">{shortHash(b.tip)}</span>
                            {b.upstreamGone && ` · ${t("Remote branch deleted")}`}
                          </div>
                          {r?.state === "removed" && <div className="text-caption text-muted-foreground">{t("Deleted branch {name}", { name: b.name })}</div>}
                          {r?.state === "skipped" && <div className="text-caption text-destructive">{t("Skipped: {reason}", { reason: r.reason })}</div>}
                          {!r && b.recent && (
                            <div className="inline-flex items-center gap-1 text-caption text-warning">
                              <Clock className="size-3" />
                              {t("Changed in the last 15 minutes; it may be about to be used")}
                            </div>
                          )}
                        </div>
                        {!r && (
                          <IconButton label={t("Keep this branch")} size="icon-sm" className="-my-0.5 text-faint-foreground" disabled={running} onClick={() => keep(b)}>
                            <Pin />
                          </IconButton>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 border-t px-3 py-2.5">
            {archived.length > 0 ? (
              <label className="flex flex-1 items-center gap-2 text-small text-muted-foreground">
                <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} disabled={running} />
                <Tooltip content={t("Each branch goes only if it still points at the worktree's commit; branches you keep and long-lived ones like develop stay")}>
                  <span>{t("Also delete the worktrees' branches")}</span>
                </Tooltip>
              </label>
            ) : (
              <span className="flex-1" />
            )}
            {candidates.isFetching && !candidates.data ? (
              <LoaderCircle className="size-4 animate-spin text-faint-foreground" />
            ) : (
              <Button size="sm" variant="destructive" disabled={count === 0 || running} onClick={confirm}>
                {label}
              </Button>
            )}
          </div>
          {done > 0 && !running && <div className="border-t px-3 py-2 text-caption text-success">{tp("Removed {n} item", "Removed {n} items", done)}</div>}
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="danger"
        title={title}
        description={description}
        confirmLabel={nTrees && nBranches ? t("Remove") : nTrees ? t("Remove worktrees") : t("Delete branches")}
        onConfirm={removeChecked}
      />
    </>
  )
}
