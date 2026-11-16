"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"
import { s } from "@/lib/strings"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"

/**
 * Copies a value. The button itself answers: 「已复制」 (or 「复制失败」) for
 * 1.5s, then back. Never a toast: the result is right where the user clicked.
 * `iconOnly` for tight spots (a code block's corner, beside a hash); the
 * label then lives in the tooltip and the accessible name.
 */
export function CopyButton({
  value,
  label,
  iconOnly,
  variant,
  size,
  ...props
}: Omit<ButtonProps, "children" | "onClick" | "value" | "size" | "asChild"> & {
  value: string
  /** What the button says before copying; defaults to 「复制」. */
  label?: string
  iconOnly?: boolean
  size?: "sm" | "md" | "icon" | "icon-sm"
}) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle")
  const timer = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => window.clearTimeout(timer.current), [])
  // every copy restarts the 1.5s, so a second click shows the full answer again
  const answer = (next: "copied" | "failed") => {
    window.clearTimeout(timer.current)
    setState(next)
    timer.current = window.setTimeout(() => setState("idle"), 1500)
  }

  const name = label ?? s().copy
  const text = state === "copied" ? s().copied : state === "failed" ? s().copyFailed : name
  const button = (
    <Button
      type="button"
      variant={variant ?? (iconOnly ? "ghost" : "secondary")}
      size={size ?? (iconOnly ? "icon-sm" : "sm")}
      aria-label={iconOnly ? name : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          answer("copied")
        } catch {
          answer("failed")
        }
      }}
      {...props}
    >
      {state === "copied" ? <Check /> : <Copy />}
      <span aria-live="polite" className={iconOnly ? "sr-only" : undefined}>
        {text}
      </span>
    </Button>
  )
  return iconOnly ? <Tooltip content={text}>{button}</Tooltip> : button
}
