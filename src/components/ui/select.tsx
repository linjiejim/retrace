"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { useFieldControl } from "@/components/ui/field"
import { controlClass } from "@/components/ui/input"

export type Option = { value: string; label: React.ReactNode; disabled?: boolean }

/**
 * Up to ~8 options. More than that, or options the user would rather type,
 * use Combobox. 2–4 options that change a view use Segmented instead.
 */
export function Select({
  options,
  value,
  onValueChange,
  placeholder = s().selectPlaceholder,
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: {
  options: Option[]
  value?: string
  onValueChange?: (v: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
  "aria-label"?: string
  "aria-labelledby"?: string
} & Omit<React.ComponentProps<typeof SelectPrimitive.Root>, "children">) {
  const field = useFieldControl()
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled} {...props}>
      <SelectPrimitive.Trigger
        {...field}
        id={id ?? field.id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(
          controlClass,
          "flex h-(--control-md) items-center justify-between gap-2 px-2.5 text-left",
          "data-placeholder:text-faint-foreground [&>span]:truncate",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 text-faint-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectPrimitive.Root>
  )
}

export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          "z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg bg-popover shadow-popover",
          "data-[state=open]:animate-drop-in data-[state=closed]:animate-drop-out",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="max-h-80 p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex min-h-(--control-md) cursor-default select-none items-center gap-2 rounded-sm py-1 pl-2 pr-8 text-body outline-none",
        "data-highlighted:bg-accent data-disabled:text-faint-foreground",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}
