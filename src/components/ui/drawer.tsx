"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { ChevronLeft, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { useGuardedOpen } from "@/hooks/use-guarded-open"
import { IconButton } from "@/components/ui/button"
import { DiscardDialog } from "@/components/ui/confirm-dialog"
import { FieldControlProvider } from "@/components/ui/field"

/*
 * Side drawer from the right: view, edit (in place, see DetailList) and
 * create a list object; a filter panel. The page behind keeps its context.
 * One drawer at a time — never stack a second one; navigate inside instead.
 *
 * Widths: sm 400 (filters, small settings), md 560 (details, default),
 * lg min(60vw, 960) (rich details). Full width on phones.
 *
 * mode="dock" is the workbench inspector: non-modal, no scrim, the main pane
 * stays clickable. From 1440 (DOCK_MIN) it docks as a column beside the main
 * pane (place <Drawer mode="dock"> last in a flex row); below it floats over
 * the page and a click outside closes it. Width 360–520 (default 400), dragged
 * from its left edge and remembered per `storageKey` (one per place). Esc
 * closes the top layer only. Nested objects: useInspectorStack (≤ 3 deep).
 */
let openCount = 0

export const DOCK_MIN = 1440
export const INSPECTOR_WIDTH = { min: 360, default: 400, max: 520 } as const

type DrawerMode = "modal" | "dock"
const ModeContext = React.createContext<DrawerMode>("modal")

export function Drawer({
  mode = "modal",
  dirty,
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { dirty?: boolean; mode?: DrawerMode }) {
  const g = useGuardedOpen({ open, defaultOpen, onOpenChange, dirty })

  React.useEffect(() => {
    if (!g.open) return
    openCount++
    // No bundler-specific env check: the kit must typecheck in Vite and Next alike.
    if (openCount > 1) console.warn("[jim-uiux] Two drawers are open. Use one drawer and navigate inside it.")
    return () => {
      openCount--
    }
  }, [g.open])

  return (
    <>
      <DialogPrimitive.Root open={g.open} onOpenChange={g.onOpenChange} modal={mode !== "dock"} {...props}>
        <ModeContext.Provider value={mode}>{children}</ModeContext.Provider>
      </DialogPrimitive.Root>
      <DiscardDialog open={g.discard.open} onKeep={g.discard.keep} onDiscard={g.discard.discard} />
    </>
  )
}

export const DrawerTrigger = DialogPrimitive.Trigger
export const DrawerClose = DialogPrimitive.Close

const widths = {
  sm: "sm:w-[400px]",
  md: "sm:w-[560px]",
  lg: "sm:w-[min(60vw,960px)] sm:min-w-[560px]",
}

export function DrawerContent({
  size = "md",
  storageKey,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: keyof typeof widths
  /** dock mode: remembers the width under this key (one per place). */
  storageKey?: string
}) {
  const mode = React.useContext(ModeContext)
  if (mode === "dock") {
    return (
      <DockContent storageKey={storageKey} className={className} {...props}>
        {children}
      </DockContent>
    )
  }
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="scrim" className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
      <DialogPrimitive.Content
        // Details are read first: focus the panel, not the first icon button (which would pop its
        // tooltip). A field marked autoFocus (creating, editing) keeps its focus.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const panel = e.currentTarget as HTMLElement
          if (!panel.contains(document.activeElement)) panel.focus()
        }}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-full flex-col bg-popover shadow-overlay outline-none",
          "data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right",
          widths[size],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** Title, optional meta line, actions (≤2 icon buttons), then ✕. `onBack` adds ← for a nested inspector object. */
export function DrawerHeader({
  title,
  description,
  actions,
  onBack,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  onBack?: () => void
  className?: string
}) {
  return (
    <div className={cn("flex shrink-0 items-start gap-2 border-b px-5 py-3.5", onBack && "pl-3", className)}>
      {onBack && (
        <IconButton label={s().back} size="icon-sm" tooltip={false} onClick={onBack} className="-my-0.5 text-muted-foreground">
          <ChevronLeft />
        </IconButton>
      )}
      <div className="min-w-0 flex-1 py-0.5">
        <DialogPrimitive.Title className="truncate text-heading font-semibold">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-0.5 truncate text-small text-muted-foreground">{description}</DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
      </div>
      {actions}
      <DialogPrimitive.Close asChild>
        <IconButton label={s().close} size="icon-sm" tooltip={false} className="text-muted-foreground">
          <X />
        </IconButton>
      </DialogPrimitive.Close>
    </div>
  )
}

function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`
  return React.useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query)
      mq.addEventListener("change", cb)
      return () => mq.removeEventListener("change", cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

const clampWidth = (w: number) => Math.round(Math.min(INSPECTOR_WIDTH.max, Math.max(INSPECTOR_WIDTH.min, w)))

function useStoredWidth(storageKey?: string) {
  const key = `inspector:width:${storageKey ?? "default"}`
  const [width, setWidth] = React.useState<number>(() => {
    const saved = typeof localStorage !== "undefined" ? Number(localStorage.getItem(key)) : NaN
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : INSPECTOR_WIDTH.default
  })
  const save = React.useCallback((w: number) => localStorage.setItem(key, String(w)), [key])
  return [width, setWidth, save] as const
}

function DockContent({
  storageKey,
  className,
  children,
  onOpenAutoFocus,
  onInteractOutside,
  onFocusOutside,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { storageKey?: string }) {
  const docked = useMinWidth(DOCK_MIN)
  const [width, setWidth, saveWidth] = useStoredWidth(storageKey)
  const drag = React.useRef<{ x: number; w: number } | null>(null)

  const resizeBy = (dx: number) =>
    setWidth((w) => {
      const next = clampWidth(w + dx)
      saveWidth(next)
      return next
    })

  return (
    <DialogPrimitive.Content
      data-mode="dock"
      data-docked={docked || undefined}
      // Docked, the inspector is part of the page: opening it leaves focus where it was (the row),
      // and clicks or focus in the main pane never close it. Floating, it behaves like a light drawer.
      onOpenAutoFocus={(e) => {
        onOpenAutoFocus?.(e)
        if (e.defaultPrevented) return
        e.preventDefault()
        if (!docked) (e.currentTarget as HTMLElement).focus()
      }}
      onInteractOutside={(e) => {
        onInteractOutside?.(e)
        if (docked) e.preventDefault()
      }}
      onFocusOutside={(e) => {
        onFocusOutside?.(e)
        if (docked) e.preventDefault()
      }}
      style={{ ...style, ["--inspector-w" as string]: `${width}px` }}
      className={cn(
        "flex flex-col outline-none sm:w-(--inspector-w)",
        docked
          ? "relative h-full shrink-0 border-l bg-background"
          : "fixed inset-y-0 right-0 z-40 h-dvh w-full max-w-full bg-popover shadow-overlay data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right",
        className,
      )}
      {...props}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={s().resizePanel}
        aria-valuemin={INSPECTOR_WIDTH.min}
        aria-valuemax={INSPECTOR_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, w: width }
        }}
        onPointerMove={(e) => {
          if (drag.current) setWidth(clampWidth(drag.current.w + drag.current.x - e.clientX))
        }}
        onPointerUp={() => {
          if (drag.current) saveWidth(width)
          drag.current = null
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
          e.preventDefault()
          resizeBy(e.key === "ArrowLeft" ? 16 : -16)
        }}
        className={cn(
          "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none max-sm:hidden",
          "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors after:duration-(--duration-fast)",
          "hover:after:bg-input focus-visible:after:bg-ring",
        )}
      />
      {children}
    </DialogPrimitive.Content>
  )
}

/**
 * The inspector's history: `show` opens an object from the main pane (a new stack), `push`
 * opens one linked from inside the inspector (≤ `max` deep; the next one replaces the top),
 * `back` returns, `close` empties it. Promoting the top object to the main pane is the caller's
 * navigation followed by `close()`.
 */
export function useInspectorStack<T>(max = 3) {
  const [stack, setStack] = React.useState<T[]>([])
  return {
    stack,
    top: stack.at(-1),
    depth: stack.length,
    show: React.useCallback((item: T) => setStack([item]), []),
    push: React.useCallback((item: T) => setStack((s) => (s.length >= max ? [...s.slice(0, max - 1), item] : [...s, item])), [max]),
    back: React.useCallback(() => setStack((s) => s.slice(0, -1)), []),
    close: React.useCallback(() => setStack([]), []),
  }
}

export function DrawerBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]", className)} {...props} />
}

export function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]", className)}
      {...props}
    />
  )
}

export type DetailItem = {
  label: React.ReactNode
  /** Shown when reading. Full contrast, selectable. */
  value: React.ReactNode
  /** Control shown in the same place while editing. Omit for read-only rows (ID, timestamps). */
  edit?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
}

/**
 * Key–value details that edit in place. Reading and editing share one layout:
 * every row is at least one control tall and values start where an input's
 * text starts, so switching modes moves nothing — the values just become
 * editable. Use it in a drawer for view → edit → save; creating uses the same
 * list with `editing` and empty values.
 */
export function DetailList({ items, editing = false, className }: { items: DetailItem[]; editing?: boolean; className?: string }) {
  const base = React.useId()
  return (
    <dl className={cn("grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-6 gap-y-1.5 text-body", className)}>
      {items.map((it, i) => {
        const id = `${base}-${i}`
        const live = editing && it.edit !== undefined
        return (
          <React.Fragment key={i}>
            <dt className="flex min-h-(--control-md) items-center self-start text-muted-foreground">
              {live ? (
                <label htmlFor={id}>
                  {it.label}
                  {it.required && (
                    <span className="ml-0.5 text-destructive" aria-hidden>
                      *
                    </span>
                  )}
                </label>
              ) : (
                it.label
              )}
            </dt>
            <dd className="flex min-h-(--control-md) min-w-0 flex-col justify-center">
              {live ? (
                <FieldControlProvider id={id} invalid={!!it.error} required={it.required} describedBy={it.error ? `${id}-error` : undefined}>
                  {it.edit}
                  {it.error && (
                    <p id={`${id}-error`} aria-live="polite" className="mt-1 text-caption text-destructive">
                      {it.error}
                    </p>
                  )}
                </FieldControlProvider>
              ) : (
                // 11px = an input's 1px border + 10px padding, so text doesn't jump when editing starts
                <div className="break-words py-1 pl-[11px] select-text">{it.value}</div>
              )}
            </dd>
          </React.Fragment>
        )
      })}
    </dl>
  )
}
