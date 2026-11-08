import * as React from "react"
import { DropdownMenu as MenuPrimitive } from "radix-ui"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * Row actions, "more" menus, account menus. Order: frequent first,
 * destructive last behind a separator. ≤ 7 items; group with separators.
 * A submenu goes one level deep and holds one set of like choices
 * (move to a project, sort by); more than that is a dialog or a combobox.
 * ContextMenu shares these classes, so both menus always look the same.
 */
export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup
export const DropdownMenuSub = MenuPrimitive.Sub

export const menuClass = {
  content: cn(
    "z-50 min-w-44 max-w-72 overflow-hidden rounded-lg bg-popover p-1 shadow-popover outline-none",
    "data-[state=open]:animate-drop-in data-[state=closed]:animate-drop-out",
  ),
  item: cn(
    "relative flex min-h-(--control-md) cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-body outline-none",
    "data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:text-faint-foreground",
    "[&_svg]:size-4 [&_svg]:text-muted-foreground",
  ),
  danger: "text-destructive [&_svg]:text-destructive",
  /** Stays highlighted while its submenu is open. */
  subTrigger: "data-[state=open]:bg-accent",
  label: "px-2 pb-1 pt-1.5 text-caption text-faint-foreground",
  separator: "-mx-1 my-1 h-px bg-border",
}

export function DropdownMenuContent({ className, align = "end", sideOffset = 4, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(menuClass.content, className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { tone?: "danger" }) {
  return <MenuPrimitive.Item className={cn(menuClass.item, tone === "danger" && menuClass.danger, className)} {...props} />
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(menuClass.item, "pr-8", className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="text-foreground!" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(menuClass.label, className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuClass.separator, className)} {...props} />
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto pl-4 text-caption text-faint-foreground", className)} {...props} />
}

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger className={cn(menuClass.item, menuClass.subTrigger, className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  )
}

/** Lines up its first item with the row that opened it. */
export function DropdownMenuSubContent({ className, sideOffset = 4, alignOffset = -4, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
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

/**
 * The parts inside a menu, as one object. Write a row's items once against
 * `MenuParts` and render them in both its ⋯ menu and its right-click menu,
 * so the two never drift: `rowMenu(dropdownMenuParts)`, `rowMenu(contextMenuParts)`.
 */
export const dropdownMenuParts = {
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Item: DropdownMenuItem,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
}
export type MenuParts = typeof dropdownMenuParts
