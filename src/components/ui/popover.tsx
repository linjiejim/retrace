import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

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
