"use client"

import * as React from "react"
import { DropdownMenu as MenuPrimitive } from "radix-ui"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * Row actions, "more" menus, account menus. Order: frequent first,
 * destructive last behind a separator. ≤ 7 items; group with separators.
 */
export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

export function DropdownMenuContent({ className, align = "end", sideOffset = 4, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 min-w-44 max-w-72 overflow-hidden rounded-lg bg-popover p-1 shadow-popover outline-none",
          "data-[state=open]:animate-drop-in data-[state=closed]:animate-drop-out",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

const itemClass = cn(
  "relative flex min-h-(--control-md) cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-body outline-none",
  "data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:text-faint-foreground",
  "[&_svg]:size-4 [&_svg]:text-muted-foreground",
)

export function DropdownMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { tone?: "danger" }) {
  return (
    <MenuPrimitive.Item
      className={cn(itemClass, tone === "danger" && "text-destructive [&_svg]:text-destructive", className)}
      {...props}
    />
  )
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, "pr-8", className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="text-foreground!" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn("px-2 pb-1 pt-1.5 text-caption text-faint-foreground", className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto pl-4 text-caption text-faint-foreground", className)} {...props} />
}
