import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * A key as printed beside what it does: 「隐藏 H」, 「⌘K 搜索」, menu shortcuts.
 * Show it where the shortcut works; on touch screens leave it out.
 */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-grid h-5 min-w-5 place-items-center rounded-xs border bg-muted px-1 font-sans text-caption leading-none font-normal whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}
