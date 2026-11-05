"use client"

import * as React from "react"
import { ToggleGroup } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * 2–4 mutually exclusive options that change how the same content is shown
 * (列表 / 看板, 日 / 周 / 月). Always has a value; can't be cleared.
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  value: T
  onValueChange: (v: T) => void
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[]
  size?: "sm" | "md"
  className?: string
  "aria-label"?: string
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 font-medium text-muted-foreground",
            "transition-colors duration-(--duration-fast) hover:text-foreground",
            "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-border",
            "[&_svg]:size-4",
            size === "sm" ? "h-[calc(var(--control-sm)-4px)] text-small" : "h-[calc(var(--control-md)-4px)] text-body",
          )}
        >
          {o.icon}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
