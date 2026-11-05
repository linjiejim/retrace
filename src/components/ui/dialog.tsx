import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { useGuardedOpen } from "@/hooks/use-guarded-open"
import { IconButton } from "@/components/ui/button"
import { DiscardDialog } from "@/components/ui/confirm-dialog"

/*
 * Dialog = a short task that needs focus and isn't a list object: rename a
 * file, invite a member, a small form. List objects are viewed, edited and
 * created in place in a Drawer (DetailList). Irreversible confirm → ConfirmDialog.
 * Under 640px it rises from the bottom as a sheet.
 *
 * Sizes: sm 400 (short prompt), md 480 (form, default), lg 640 (two-column
 * or rich content), xl workspace min(90vw, 1200).
 */
export function Dialog({
  dirty,
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { dirty?: boolean }) {
  const g = useGuardedOpen({ open, defaultOpen, onOpenChange, dirty })
  return (
    <>
      <DialogPrimitive.Root open={g.open} onOpenChange={g.onOpenChange} {...props}>
        {children}
      </DialogPrimitive.Root>
      <DiscardDialog open={g.discard.open} onKeep={g.discard.keep} onDiscard={g.discard.discard} />
    </>
  )
}

export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

const sizes = {
  sm: "sm:max-w-[400px]",
  md: "sm:max-w-[480px]",
  lg: "sm:max-w-[640px]",
  xl: "sm:max-w-[min(90vw,1200px)] sm:h-[85dvh]",
}

export function DialogContent({
  size = "md",
  className,
  children,
  hideClose,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { size?: keyof typeof sizes; hideClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="scrim" className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex max-h-[85dvh] flex-col bg-popover shadow-overlay outline-none",
          // desktop: centered card
          "sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl",
          "sm:data-[state=open]:animate-pop-in sm:data-[state=closed]:animate-pop-out",
          // phone: bottom sheet
          "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-2xl",
          "max-sm:data-[state=open]:animate-slide-in-up max-sm:data-[state=closed]:animate-slide-out-down",
          sizes[size],
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close asChild>
            <IconButton label={s().close} size="icon-sm" tooltip={false} className="absolute right-3 top-3 text-muted-foreground">
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({
  title,
  description,
  className,
}: {
  title: React.ReactNode
  /** One short line, only when the title alone is not enough. */
  description?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("shrink-0 px-5 pb-3 pr-12 pt-5", className)}>
      <DialogPrimitive.Title className="truncate text-title font-semibold">{title}</DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description className="mt-1 text-body text-muted-foreground">{description}</DialogPrimitive.Description>
      ) : (
        <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
      )}
    </div>
  )
}

export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-2 [scrollbar-gutter:stable]", className)} {...props} />
}

/** Secondary left of primary, right-aligned. On phones the buttons share the row. */
export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 px-5 pb-5 pt-4",
        "max-sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] max-sm:[&>button]:flex-1",
        className,
      )}
      {...props}
    />
  )
}
