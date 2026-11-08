"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close
// Puts the panel somewhere other than its trigger: a point on a canvas or in a
// 3D view (`virtualRef` to an object with `getBoundingClientRect`), a word in
// the text. Whatever opens it still needs a keyboard path. Pass a new
// `virtualRef` object whenever the point moves: Radix re-measures only when the
// anchor object changes (a fixed one can also lose to a PopoverTrigger in StrictMode).
export const PopoverAnchor = PopoverPrimitive.Anchor

/** Small, non-blocking panel anchored to its trigger: filters, pickers, quick edits. */
export function PopoverContent({ className, align = "start", sideOffset = 4, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 w-72 rounded-lg bg-popover p-3 text-body shadow-popover outline-none",
          "data-[state=open]:animate-drop-in data-[state=closed]:animate-drop-out",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
