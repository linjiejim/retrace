import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, Clock, LoaderCircle } from "lucide-react"
import { api } from "@/lib/api"
import { ago, tildify } from "@/lib/format"
import type { CleanupCandidate } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { invalidateProject, useCleanupCandidates, type Tab } from "@/hooks/queries"
import type { useProjectView } from "@/hooks/use-project-view"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip } from "@/components/ui/tooltip"
import { notify } from "@/components/ui/toast"

type Result = { state: "running" } | { state: "removed"; note: string | null } | { state: "skipped"; reason: string }

/** Clean worktrees already in the trunk, folded next to the main tree; view one, or remove them. `children` is the trigger. */
export function ArchiveMenu({
  view,
  archived,
  onOpen,
  children,
}: {
  view: ReturnType<typeof useProjectView>
  archived: Tab[]
  onOpen: (t: Tab) => void
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
  const [pending, setPending] = useState<CleanupCandidate[]>([])
  const [results, setResults] = useState<Record<string, Result>>({})
  const byPath = useMemo(() => new Map((candidates.data ?? []).map((c) => [c.path, c])), [candidates.data])

  // Each ticked tree remembers the warnings it was ticked under. Ticks are set once per opening
  // (safe trees only); a refresh drops trees that stopped qualifying and un-ticks any tree whose
  // warnings changed since, so a new .env or fresh activity always needs a new, explicit tick.
  const seen = useRef(new Map<string, string>())
  const initialized = useRef(false)
  const warnings = (c: CleanupCandidate) => JSON.stringify([c.notableIgnored, c.recent])
  useEffect(() => {
    if (!open) {
      setResults({})
      initialized.current = false
      return
    }
    if (!candidates.data) return
    if (!initialized.current) {
      initialized.current = true
      const safe = candidates.data.filter((c) => c.notableIgnored.length === 0 && !c.recent)
      seen.current = new Map(safe.map((c) => [c.path, warnings(c)]))
      setChecked(new Set(safe.map((c) => c.path)))
      return
    }
    const now = new Map(candidates.data.map((c) => [c.path, warnings(c)]))
    setChecked((prev) => new Set([...prev].filter((p) => now.has(p) && now.get(p) === seen.current.get(p))))
  }, [open, candidates.data])

  const toggle = (c: CleanupCandidate) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(c.path)) next.delete(c.path)
      else {
        next.add(c.path)
        seen.current.set(c.path, warnings(c))
      }
      return next
    })

  const confirm = () => {
    setPending([...checked].map((p) => byPath.get(p)).filter((c): c is CleanupCandidate => !!c))
    setConfirming(true)
  }

  const removeChecked = async () => {
    const list = pending
    let removed = 0
    const skipped: string[] = []
    for (const c of list) {
      setResults((r) => ({ ...r, [c.path]: { state: "running" } }))
      try {
        const out = await api.removeWorktree(projectId!, c.path, c.head, c.notableIgnored, deleteBranch)
        const note = out.branchDeleted ? t("Deleted branch {name}", { name: c.branch ?? "" }) : out.branchKeptReason
        setResults((r) => ({ ...r, [c.path]: { state: "removed", note } }))
        removed++
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        setResults((r) => ({ ...r, [c.path]: { state: "skipped", reason } }))
        skipped.push(`${c.branch ?? c.path}：${reason}`)
      }
    }
    setChecked(new Set())
    invalidateProject(qc, projectId!, { git: true, trees: [] })
    // The menu disappears once nothing is left in it, so say what happened.
    if (skipped.length) notify.warning(t("Removed {removed}, skipped {skipped} ({first})", { removed, skipped: skipped.length, first: skipped[0] }))
    else if (removed) notify.success(tp("Removed {n} worktree", "Removed {n} worktrees", removed))
  }

  const done = Object.values(results).filter((r) => r.state === "removed").length
  const running = Object.values(results).some((r) => r.state === "running")

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent className="w-[440px] p-0" align="start">
          <div className="px-3 pb-1 pt-2.5 text-caption text-faint-foreground">{t("Clean worktrees already in {trunk}: safe to remove", { trunk: trunk?.name ?? t("the trunk") })}</div>
          <ul className="max-h-[50vh] overflow-y-auto px-1 pb-1">
            {archived.map((tab) => {
              const c = tab.tree ? byPath.get(tab.tree.path) : undefined
              const r = tab.tree ? results[tab.tree.path] : undefined
              const integration = tab.status?.trunk?.integration
              return (
                <li key={tab.key} className="flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
                  <span className="pt-0.5">
                    {r?.state === "running" ? (
                      <Spinner className="size-4" />
                    ) : r?.state === "removed" ? (
                      <CircleCheck className="size-4 text-success" />
                    ) : r?.state === "skipped" ? (
                      <CircleAlert className="size-4 text-destructive" />
                    ) : (
                      <Checkbox disabled={!c || running} checked={!!c && checked.has(c.path)} onCheckedChange={() => c && toggle(c)} aria-label={t("Select {name}", { name: tab.label })} />
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
          <div className="flex items-center gap-3 border-t px-3 py-2.5">
            <label className="flex flex-1 items-center gap-2 text-small text-muted-foreground">
              <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} disabled={running} />
              <Tooltip content={t("Uses git branch -d only; squash-merged branches can't be deleted that way and are kept")}>
                <span>{t("Also delete the merged local branches")}</span>
              </Tooltip>
            </label>
            {candidates.isFetching && !candidates.data ? (
              <LoaderCircle className="size-4 animate-spin text-faint-foreground" />
            ) : (
              <Button size="sm" variant="destructive" disabled={checked.size === 0 || running} onClick={confirm}>
                {checked.size ? tp("Remove {n} worktree", "Remove {n} worktrees", checked.size) : t("Remove worktrees")}
              </Button>
            )}
          </div>
          {done > 0 && !running && <div className="border-t px-3 py-2 text-caption text-success">{tp("Removed {n} worktree", "Removed {n} worktrees", done)}</div>}
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="danger"
        title={tp("Remove {n} worktree?", "Remove {n} worktrees?", pending.length)}
        description={deleteBranch ? t("Deletes these folders (without --force, each checked again first) and their merged local branches with git branch -d. Ignored files in them are deleted too.") : t("Deletes these folders (without --force, each checked again first). Ignored files in them are deleted too.")}
        confirmLabel={t("Remove worktrees")}
        onConfirm={removeChecked}
      />
    </>
  )
}
