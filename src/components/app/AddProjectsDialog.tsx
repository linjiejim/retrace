import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { tildify } from "@/lib/format"
import { t, tp } from "@/lib/i18n"
import { s } from "@/lib/strings"
import type { AddState } from "@/lib/store"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

/** Browser: type a path. Parent folder chosen: tick the repositories inside it. */
export function AddProjectsDialog({
  state,
  onClose,
  onAddPaths,
  onAdded,
}: {
  state: AddState
  onClose: () => void
  onAddPaths: (paths: string[]) => Promise<void>
  onAdded: (id: string) => void
}) {
  const qc = useQueryClient()
  const [path, setPath] = useState("")
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  if (state.step === "path") {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent size="sm">
          <DialogHeader title={t("Add project")} />
          <DialogBody>
            <Input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/Code/repo" />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {s().cancel}
            </Button>
            <Button
              variant="primary"
              disabled={!path.trim()}
              loading={busy}
              onClick={async () => {
                setBusy(true)
                await onAddPaths([path.trim()])
                setBusy(false)
              }}
            >
              {t("Add project")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  const fresh = state.candidates.filter((c) => !c.added)
  const allOn = fresh.length > 0 && fresh.every((c) => checked.has(c.path))
  const toggle = (p: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader title={t("Choose repositories to add")} description={tp("Found {n} repository in this folder.", "Found {n} repositories in this folder.", state.candidates.length)} />
        <DialogBody className="max-h-[50vh]">
          <label className="flex h-8 items-center gap-2 border-b text-small text-muted-foreground">
            <Checkbox checked={allOn} onCheckedChange={(v) => setChecked(v ? new Set(fresh.map((c) => c.path)) : new Set())} />
            {t("Select all")}
          </label>
          <ul>
            {state.candidates.map((c) => (
              <li key={c.path}>
                <label className="flex h-8 items-center gap-2 text-body">
                  <Checkbox disabled={c.added} checked={c.added || checked.has(c.path)} onCheckedChange={() => toggle(c.path)} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="truncate text-caption text-faint-foreground">{c.added ? t("Already added") : tildify(c.path)}</span>
                </label>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {s().cancel}
          </Button>
          <Button
            variant="primary"
            disabled={checked.size === 0}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              const added = await api.addProjects([...checked])
              await qc.invalidateQueries({ queryKey: ["projects"] })
              setBusy(false)
              if (added[0]) onAdded(added[0].id)
              onClose()
            }}
          >
            {checked.size ? tp("Add {n} project", "Add {n} projects", checked.size) : t("Add project")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
