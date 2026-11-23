"use client"

import * as React from "react"
import { Toaster as Sonner, toast } from "sonner"
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react"
import { s } from "@/lib/strings"
import { Spinner } from "@/components/ui/spinner"

/*
 * Toasts confirm something that happened away from where the user is
 * looking, or offer Undo. Rules:
 *   - success: 4s, only when the result isn't already visible on screen
 *   - undo:    8s, for reversible actions done without a confirm dialog
 *   - info with an action: 8s (已更新到 0.7.6 · 查看更新内容)
 *   - error:   stays until closed, with Retry when possible. Errors that
 *              belong to a field or a section are shown there, not here.
 *   - prompt:  stays until closed or acted on, for something waiting on the
 *              user that isn't an error (an update is installed: Restart).
 *              One per thing: showing the same id again replaces it.
 *   - loading: a slow step the user started that runs out of view (download,
 *              big export). Dismiss it by id when done, then report the
 *              result as usual. Waits on the page use Skeleton or Spinner.
 *   - never toast and dialog for the same event
 * Top right, stacked (newest in front, expands on hover); phones: top,
 * full width, below the safe area. Max 3 visible. Every toast but loading
 * has ✕ in its top-right corner: the corner is where page and drawer headers
 * keep their actions, so a toast must be quick to clear.
 *
 * Level shows quietly: a raised surface, the icon carries the status colour;
 * only errors (which stay) add a faint red tint.
 */
export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      position="top-right"
      visibleToasts={3}
      gap={8}
      offset={16}
      mobileOffset={{ top: "max(12px, env(safe-area-inset-top))", left: 12, right: 12 }}
      closeButton
      containerAriaLabel={s().notifications}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: s().close,
        classNames: {
          // the error tint rides on data-type: as a plain class in `error` it loses to bg-popover
          toast:
            "group pointer-events-auto flex w-full items-center gap-3 rounded-lg bg-popover px-4 py-3 text-body text-foreground shadow-overlay data-[type=error]:bg-destructive-subtle sm:w-[360px]",
          success: "[&_[data-icon]]:text-success",
          info: "[&_[data-icon]]:text-info",
          warning: "[&_[data-icon]]:text-warning",
          error: "[&_[data-icon]]:text-destructive",
          content: "min-w-0 flex-1",
          title: "font-normal",
          description: "text-small text-muted-foreground",
          // relative: sonner centres the loading icon on its nearest positioned box
          icon: "relative flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
          actionButton:
            "shrink-0 rounded-sm px-2 py-0.5 font-medium text-foreground underline-offset-4 hover:underline",
          cancelButton: "shrink-0 rounded-sm px-2 py-0.5 text-muted-foreground hover:text-foreground",
          // top-right corner: last in the row, pinned to the first line; 44px to a finger
          closeButton:
            "relative order-last -my-px -mr-1.5 flex size-6 shrink-0 items-center justify-center self-start rounded-sm border-0! bg-transparent! text-muted-foreground! hover:bg-accent! hover:text-foreground! after:absolute pointer-coarse:after:-inset-2.5 [&_svg]:size-4",
        },
      }}
      icons={{
        success: <CircleCheck />,
        info: <Info />,
        warning: <TriangleAlert />,
        error: <CircleAlert />,
        loading: <Spinner className="text-muted-foreground" />,
        close: <X />,
      }}
      {...props}
    />
  )
}

type Id = string | number
type Action = { label: string; onClick: () => void }

/**
 * Let go of focus before acting. A click focuses the action button; if the action opens a dialog,
 * sonner hands focus back to whatever had it before the toast (behind the dialog) and the dialog
 * takes that as a click outside and closes. Blurring first lets sonner do that before the dialog.
 */
const act = ({ label, onClick }: Action) => ({
  label,
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur()
    onClick()
  },
})

/** The only way the app raises toasts. Keep messages to one short sentence. */
export const notify = Object.assign((message: React.ReactNode) => toast(message, { duration: 4000 }), {
  success: (message: React.ReactNode) => toast.success(message, { duration: 4000 }),
  /**
   * Neutral fact the user should know (同步将在后台完成). With an `action` it stays 8s, like undo,
   * so there is time to take it (已更新到 0.7.6 · 查看更新内容).
   */
  info: (message: React.ReactNode, opts?: { action?: Action }) =>
    toast.info(message, { duration: opts?.action ? 8000 : 4000, action: opts?.action && act(opts.action) }),
  /** Done, but with a caveat (已导出 98 条，2 条因格式问题跳过). */
  warning: (message: React.ReactNode) => toast.warning(message, { duration: 6000 }),
  undo: (message: React.ReactNode, onUndo: () => void) =>
    toast(message, { duration: 8000, action: act({ label: s().undo, onClick: onUndo }) }),
  error: (message: React.ReactNode, opts?: { retry?: () => void }) =>
    toast.error(message, {
      duration: Infinity,
      closeButton: true,
      action: opts?.retry ? act({ label: s().retry, onClick: opts.retry }) : undefined,
    }),
  /** Waiting on the user, not an error (更新已下载 · 重启). Same `id` replaces the last one. */
  prompt: (id: Id, message: React.ReactNode, action: Action) =>
    toast(message, { id, duration: Infinity, closeButton: true, action: act(action) }),
  /** Returns the id to dismiss when the step ends. */
  loading: (message: React.ReactNode): Id => toast.loading(message, { duration: Infinity }),
  dismiss: (id?: Id) => toast.dismiss(id),
})
