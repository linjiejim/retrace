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
 *   - error:   stays until closed, with Retry when possible. Errors that
 *              belong to a field or a section are shown there, not here.
 *   - prompt:  stays until closed or acted on, for something waiting on the
 *              user that isn't an error (an update is installed: Restart).
 *              One per thing: showing the same id again replaces it.
 *   - loading: a slow step the user started that runs out of view (download,
 *              big export). Dismiss it by id when done, then report the
 *              result as usual. Waits on the page use Skeleton or Spinner.
 *   - never toast and dialog for the same event
 * Top centre, stacked (newest in front, expands on hover); phones: top,
 * full width, below the safe area. Max 3 visible.
 *
 * Level shows quietly: a raised surface, the icon carries the status colour;
 * only errors (which stay) add a faint red tint.
 */
export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      position="top-center"
      visibleToasts={3}
      gap={8}
      offset={16}
      mobileOffset={{ top: "max(12px, env(safe-area-inset-top))", left: 12, right: 12 }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group pointer-events-auto flex w-full items-center gap-3 rounded-lg bg-popover px-4 py-3 text-body text-foreground shadow-overlay sm:w-[360px]",
          success: "[&_[data-icon]]:text-success",
          info: "[&_[data-icon]]:text-info",
          warning: "[&_[data-icon]]:text-warning",
          error: "bg-destructive-subtle [&_[data-icon]]:text-destructive",
          content: "min-w-0 flex-1",
          title: "font-normal",
          description: "text-small text-muted-foreground",
          // relative: sonner centres the loading icon on its nearest positioned box
          icon: "relative flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
          actionButton:
            "shrink-0 rounded-sm px-2 py-0.5 font-medium text-foreground underline-offset-4 hover:underline",
          cancelButton: "shrink-0 rounded-sm px-2 py-0.5 text-muted-foreground hover:text-foreground",
          closeButton:
            "order-last! static! translate-none! shrink-0 rounded-sm border-0! bg-transparent! text-muted-foreground! hover:text-foreground! [&_svg]:size-4",
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

/** The only way the app raises toasts. Keep messages to one short sentence. */
export const notify = Object.assign((message: React.ReactNode) => toast(message, { duration: 4000 }), {
  success: (message: React.ReactNode) => toast.success(message, { duration: 4000 }),
  /** Neutral fact the user should know (同步将在后台完成). */
  info: (message: React.ReactNode) => toast.info(message, { duration: 4000 }),
  /** Done, but with a caveat (已导出 98 条，2 条因格式问题跳过). */
  warning: (message: React.ReactNode) => toast.warning(message, { duration: 6000 }),
  undo: (message: React.ReactNode, onUndo: () => void) =>
    toast(message, { duration: 8000, action: { label: s().undo, onClick: onUndo } }),
  error: (message: React.ReactNode, opts?: { retry?: () => void }) =>
    toast.error(message, {
      duration: Infinity,
      closeButton: true,
      action: opts?.retry ? { label: s().retry, onClick: opts.retry } : undefined,
    }),
  /** Waiting on the user, not an error (更新已下载 · 重启). Same `id` replaces the last one. */
  prompt: (id: Id, message: React.ReactNode, action: { label: string; onClick: () => void }) =>
    toast(message, { id, duration: Infinity, closeButton: true, action }),
  /** Returns the id to dismiss when the step ends. */
  loading: (message: React.ReactNode): Id => toast.loading(message, { duration: Infinity }),
  dismiss: (id?: Id) => toast.dismiss(id),
})
