"use client"

import * as React from "react"
import { ContextMenu as MenuPrimitive } from "radix-ui"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { DropdownMenuShortcut, menuClass, type MenuParts } from "@/components/ui/dropdown-menu"

/*
 * Right-click menus, for desktop tools and dense lists. Same look and rules
 * as DropdownMenu. Right-click is a shortcut, never the only way in: the row's
 * ⋯ menu offers the same items in the same order (write them once against
 * `MenuParts`), because touch gets it only by long-press and keyboards by ⋯.
 */
export const ContextMenu = MenuPrimitive.Root
export const ContextMenuTrigger = MenuPrimitive.Trigger
export const ContextMenuGroup = MenuPrimitive.Group
export const ContextMenuRadioGroup = MenuPrimitive.RadioGroup
export const ContextMenuSub = MenuPrimitive.Sub
export const ContextMenuShortcut = DropdownMenuShortcut

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content collisionPadding={8} className={cn(menuClass.content, className)} {...props} />
    </MenuPrimitive.Portal>
  )
}

export function ContextMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { tone?: "danger" }) {
  return <MenuPrimitive.Item className={cn(menuClass.item, tone === "danger" && menuClass.danger, className)} {...props} />
}

export function ContextMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(menuClass.item, "pr-8", className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="text-foreground!" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

export function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(menuClass.label, className)} {...props} />
}

export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuClass.separator, className)} {...props} />
}

export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger className={cn(menuClass.item, menuClass.subTrigger, className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  )
}

export function ContextMenuSubContent({ className, sideOffset = 4, alignOffset = -4, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={8}
        className={cn(menuClass.content, className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

/** Same shape as `dropdownMenuParts`: pass either to a function that writes a row's items. */
export const contextMenuParts: MenuParts = {
  Group: ContextMenuGroup,
  Label: ContextMenuLabel,
  Item: ContextMenuItem,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
}
