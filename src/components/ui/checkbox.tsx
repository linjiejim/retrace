import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Check, Minus } from "lucide-react"
import { cn } from "@/lib/utils"

/** 16px box, 44px hit area on touch. Multi-choice and row selection. */
export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative grid size-4 shrink-0 place-items-center rounded-xs border border-input bg-background",
        "transition-colors duration-(--duration-fast) hover:border-faint-foreground",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "after:absolute after:-inset-2 pointer-coarse:after:-inset-3.5",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="[&_svg]:size-3 [&_svg]:stroke-3">
        {props.checked === "indeterminate" ? <Minus /> : <Check />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
