"use client"

import * as React from "react"
import { CircleAlert, Inbox, Lock, SearchX } from "lucide-react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { Button } from "@/components/ui/button"

/*
 * The four non-content states. Each looks different so a failure never
 * passes for "no data".
 *   empty          nothing here yet → one action that creates the first item
 *   no-match       filters/search hide everything → clear filters
 *   no-permission  say so, and who can grant it
 *   error          plain words, no codes → retry
 * One icon, one title, at most one line of text, at most one action.
 */
export type StateKind = "empty" | "no-match" | "no-permission" | "error"

const icons: Record<StateKind, React.ReactNode> = {
  empty: <Inbox />,
  "no-match": <SearchX />,
  "no-permission": <Lock />,
  error: <CircleAlert />,
}

export function StateView({
  kind,
  title,
  description,
  action,
  onRetry,
  onClearFilters,
  icon,
  size = "md",
  className,
}: {
  kind: StateKind
  title?: React.ReactNode
  description?: React.ReactNode
  /** Overrides the default action of the kind. */
  action?: React.ReactNode
  onRetry?: () => void
  onClearFilters?: () => void
  icon?: React.ReactNode
  /** sm inside panels and tables, md for a page section. */
  size?: "sm" | "md"
  className?: string
}) {
  const t = s()
  const defaults = {
    empty: { title: t.emptyTitle, description: undefined },
    "no-match": { title: t.noMatchTitle, description: undefined },
    "no-permission": { title: t.noPermissionTitle, description: t.noPermissionBody },
    error: { title: t.errorTitle, description: t.errorBody },
  }[kind]

  const defaultAction =
    kind === "error" && onRetry ? (
      <Button size="sm" onClick={onRetry}>
        {t.retry}
      </Button>
    ) : kind === "no-match" && onClearFilters ? (
      <Button size="sm" onClick={onClearFilters}>
        {t.noMatchAction}
      </Button>
    ) : null

  const act = action ?? defaultAction
  return (
    <div
      role={kind === "error" ? "alert" : undefined}
      className={cn("flex flex-col items-center justify-center text-center", size === "sm" ? "px-4 py-10" : "px-6 py-16", className)}
    >
      <div className={cn("mb-3 text-faint-foreground", size === "sm" ? "[&_svg]:size-6" : "[&_svg]:size-8")}>{icon ?? icons[kind]}</div>
      <p className="text-heading font-medium">{title ?? defaults.title}</p>
      {(description ?? defaults.description) && (
        <p className="mt-1 max-w-sm text-body text-muted-foreground">{description ?? defaults.description}</p>
      )}
      {act && <div className="mt-4">{act}</div>}
    </div>
  )
}
