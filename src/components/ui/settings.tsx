import * as React from "react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { Button } from "@/components/ui/button"

/*
 * Settings pages:
 *   - narrow page (720), sections with a heading, rows separated by hairlines,
 *     no cards around sections
 *   - a row: name + one short line on the left, the control on the right
 *   - switches and selects save at once (notify.success only if the effect
 *     isn't visible); text fields collect into a SaveBar
 *   - destructive settings live in a last "危险操作" section, each behind a
 *     ConfirmDialog
 * Settings in a dialog (a desktop app's preferences): `variant="grouped"`. Each
 * section is a card under a small label (with an optional icon); in a compact
 * dialog a bare heading is barely larger than the row names and the groups run
 * together.
 */
export function SettingsSection({
  title,
  icon,
  variant = "page",
  children,
  className,
}: {
  title: React.ReactNode
  /** Grouped only: a lucide icon before the label. */
  icon?: React.ReactNode
  variant?: "page" | "grouped"
  children: React.ReactNode
  className?: string
}) {
  if (variant === "grouped") {
    return (
      <section className={cn("mt-5 first:mt-0", className)}>
        <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-small font-semibold text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
          {icon}
          {title}
        </h3>
        <div className="divide-y rounded-lg bg-sunken px-4 ring-1 ring-border">{children}</div>
      </section>
    )
  }
  return (
    <section className={cn("mt-10 first:mt-0", className)}>
      <h2 className="mb-1 text-heading font-semibold">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  )
}

export function SettingRow({
  label,
  description,
  control,
  htmlFor,
  stack,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  control: React.ReactNode
  htmlFor?: string
  /** Put the control under the text (wide inputs, long selects). */
  stack?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex gap-x-6 gap-y-2 py-3.5", stack ? "flex-col" : "items-center max-sm:flex-col max-sm:items-stretch", className)}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-body font-medium">
          {label}
        </label>
        {description && <p className="mt-0.5 text-small text-muted-foreground">{description}</p>}
      </div>
      <div className={cn("shrink-0", stack && "w-full")}>{control}</div>
    </div>
  )
}

/** Sticky bar shown while text settings have unsaved changes. */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  className,
}: {
  dirty: boolean
  saving?: boolean
  onSave: () => void
  onDiscard: () => void
  className?: string
}) {
  if (!dirty && !saving) return null
  return (
    <div
      role="region"
      aria-label={s().unsaved}
      className={cn(
        "sticky bottom-4 z-10 mt-6 flex items-center gap-3 rounded-lg bg-popover px-4 py-2.5 shadow-overlay animate-drop-in",
        "max-sm:bottom-[max(1rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      <span className="flex-1 text-body text-muted-foreground">{s().unsaved}</span>
      <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
        {s().discard}
      </Button>
      <Button variant="primary" size="sm" onClick={onSave} loading={saving}>
        {s().save}
      </Button>
    </div>
  )
}
