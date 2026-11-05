import * as React from "react"
import { AlertDialog as AlertPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { Button } from "@/components/ui/button"

/*
 * Only for irreversible or costly actions. Reversible ones (archive, remove
 * from list, toggle) act at once and offer Undo in a toast instead.
 *
 * Title asks the question ("删除项目「官网改版」？"), the body says the
 * consequence in one line, the confirm button repeats the verb ("删除项目").
 * Focus starts on Cancel; Enter does not destroy anything by accident.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = s().cancel,
  tone = "default",
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: "default" | "danger"
  /** May return a promise: the button shows progress, the dialog stays open on failure. */
  onConfirm: () => void | Promise<void>
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) setError(null)
  }, [open])

  const run = async () => {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertPrimitive.Root open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay data-slot="scrim" className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <AlertPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl bg-popover p-5 shadow-overlay",
            "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          )}
        >
          <AlertPrimitive.Title className="text-heading font-semibold">{title}</AlertPrimitive.Title>
          {description ? (
            <AlertPrimitive.Description className="mt-1.5 text-body text-muted-foreground">{description}</AlertPrimitive.Description>
          ) : (
            <AlertPrimitive.Description className="sr-only">{title}</AlertPrimitive.Description>
          )}
          {error && (
            <p role="alert" className="mt-3 rounded-md bg-destructive-subtle px-3 py-2 text-small text-destructive">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2 max-sm:[&>*]:flex-1">
            <AlertPrimitive.Cancel asChild>
              <Button variant="secondary" disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertPrimitive.Cancel>
            <Button
              variant={tone === "danger" ? "destructive" : "primary"}
              loading={pending}
              onClick={(e) => {
                e.preventDefault()
                void run()
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  )
}

/** Asked when closing an overlay that holds unsaved input. */
export function DiscardDialog({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onKeep()}
      title={s().discardTitle}
      description={s().discardBody}
      cancelLabel={s().discardKeep}
      confirmLabel={s().discardConfirm}
      tone="danger"
      onConfirm={onDiscard}
    />
  )
}

type ConfirmOptions = Omit<React.ComponentProps<typeof ConfirmDialog>, "open" | "onOpenChange" | "onConfirm"> & {
  onConfirm?: () => void | Promise<void>
}

/**
 * Imperative form: `if (await confirm({...})) …`. Render `element` once.
 * Resolves true after onConfirm succeeds, false on cancel.
 */
export function useConfirm() {
  const [state, setState] = React.useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const [open, setOpen] = React.useState(false)
  const settled = React.useRef(false)

  const confirm = React.useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        settled.current = false
        setState({ ...opts, resolve })
        setOpen(true)
      }),
    [],
  )

  const element = state ? (
    <ConfirmDialog
      {...state}
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o && !settled.current) {
          settled.current = true
          state.resolve(false)
        }
      }}
      onConfirm={async () => {
        await state.onConfirm?.()
        settled.current = true
        state.resolve(true)
      }}
    />
  ) : null

  return { confirm, element }
}
