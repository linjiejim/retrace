"use client"

import * as React from "react"
import { ContextMenu as MenuPrimitive } from "radix-ui"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * Right-click menus. Same look and rules as DropdownMenu: a row's right-click
 * menu offers what its "more" button offers, in the same order.
 */
export const ContextMenu = MenuPrimitive.Root
export const ContextMenuTrigger = MenuPrimitive.Trigger
export const ContextMenuSub = MenuPrimitive.Sub

const contentClass = cn(
  "z-50 min-w-44 max-w-72 overflow-hidden rounded-lg bg-popover p-1 shadow-popover outline-none",
  "data-[state=open]:animate-drop-in data-[state=closed]:animate-drop-out",
)

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content collisionPadding={8} className={cn(contentClass, className)} {...props} />
    </MenuPrimitive.Portal>
  )
}

const itemClass = cn(
  "relative flex min-h-(--control-md) cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-body outline-none",
  "data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:text-faint-foreground",
  "[&_svg]:size-4 [&_svg]:text-muted-foreground",
)

export function ContextMenuItem({ className, tone, ...props }: React.ComponentProps<typeof MenuPrimitive.Item> & { tone?: "danger" }) {
  return <MenuPrimitive.Item className={cn(itemClass, tone === "danger" && "text-destructive [&_svg]:text-destructive", className)} {...props} />
}

export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger className={cn(itemClass, "data-[state=open]:bg-accent", className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  )
}

export function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent collisionPadding={8} className={cn(contentClass, className)} {...props} />
    </MenuPrimitive.Portal>
  )
}

export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}
