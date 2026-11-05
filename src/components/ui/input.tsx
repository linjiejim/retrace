"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useFieldControl } from "@/components/ui/field"

export const controlClass = cn(
  "w-full min-w-0 rounded-md border border-input bg-background text-body text-foreground",
  "placeholder:text-faint-foreground",
  "transition-[border-color,box-shadow] duration-(--duration-fast)",
  "outline-none focus-visible:outline-none focus:border-ring focus:ring-3 focus:ring-ring/15",
  "aria-invalid:border-destructive aria-invalid:focus:ring-destructive/15",
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-faint-foreground",
)

// :read-only also matches buttons, so only text controls get the read-only look.
const readOnlyClass = "read-only:bg-sunken read-only:focus:ring-0"

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  const field = useFieldControl()
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(controlClass, readOnlyClass, "h-(--control-md) px-2.5", className)}
      {...field}
      {...props}
    />
  )
}

export function Textarea({ className, rows = 3, ...props }: React.ComponentProps<"textarea">) {
  const field = useFieldControl()
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(controlClass, readOnlyClass, "field-sizing-content min-h-20 resize-y px-2.5 py-1.5", className)}
      {...field}
      {...props}
    />
  )
}
