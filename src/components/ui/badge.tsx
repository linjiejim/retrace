import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/*
 * Status and short labels. Colour carries meaning, text always says it too.
 * One fixed vocabulary per project: e.g. 进行中 = info, 已完成 = success,
 * 需处理 = warning, 失败 = danger, 草稿/已归档 = neutral.
 */
export const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-caption font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        success: "bg-success-subtle text-success",
        warning: "bg-warning-subtle text-warning",
        danger: "bg-destructive-subtle text-destructive",
        info: "bg-info-subtle text-info",
        outline: "border text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
)

export function Badge({
  className,
  tone,
  dot,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** Inline status: a dot plus text, no fill. For dense tables and lists. */
export function StatusDot({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "info"
  children: React.ReactNode
  className?: string
}) {
  const color = {
    neutral: "bg-faint-foreground",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-info",
  }[tone]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-body", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", color)} />
      {children}
    </span>
  )
}
