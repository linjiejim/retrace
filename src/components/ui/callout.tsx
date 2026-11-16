import * as React from "react"
import { CircleAlert, Info, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A note that stays on the page until its cause is gone: a value shown only
 * once, a setup that's missing, why the action in this dialog failed. Icon +
 * one or two sentences, at most one action at the end.
 *
 * The tint says the level, the icon says it too (colour is never the only
 * signal). Not for results (Toast), a failed section (StateView), a field's
 * error (Field), or explanations (Info).
 */
const tones = {
  info: { box: "bg-info-subtle", icon: "text-info", Icon: Info },
  warning: { box: "bg-warning-subtle", icon: "text-warning", Icon: TriangleAlert },
  danger: { box: "bg-destructive-subtle", icon: "text-destructive", Icon: CircleAlert },
  neutral: { box: "bg-muted", icon: "text-muted-foreground", Icon: Info },
}

export function Callout({
  tone = "info",
  icon,
  action,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: keyof typeof tones
  /** Replaces the tone's icon. */
  icon?: React.ReactNode
  action?: React.ReactNode
}) {
  const t = tones[tone]
  return (
    <div
      data-slot="callout"
      // a failure appears while the user waits on it: say it
      role={tone === "danger" ? "alert" : undefined}
      className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-small text-foreground", t.box, className)}
      {...props}
    >
      <span aria-hidden className={cn("flex h-5 shrink-0 items-center [&_svg]:size-4", t.icon)}>
        {icon ?? <t.Icon />}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="-my-0.5 shrink-0">{action}</div>}
    </div>
  )
}
