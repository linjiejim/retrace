import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * An on/off setting that takes effect immediately. If the change only applies
 * after a Save button, use a Checkbox instead.
 */
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5",
        "bg-input transition-colors duration-(--duration-fast) data-[state=checked]:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "after:absolute after:-inset-1.5 pointer-coarse:after:-inset-3",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-4 rounded-full bg-background shadow-popover transition-transform duration-(--duration-fast) ease-out",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground",
          "dark:data-[state=unchecked]:bg-muted-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  )
}
