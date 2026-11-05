"use client"

import * as React from "react"
import { CircleAlert, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { Tooltip } from "@/components/ui/tooltip"

type FieldCtx = { id: string; describedBy?: string; invalid: boolean; required: boolean }
const FieldContext = React.createContext<FieldCtx | null>(null)

/** Inputs inside a Field pick up id, aria-describedby, aria-invalid, required. */
export function useFieldControl() {
  const ctx = React.useContext(FieldContext)
  if (!ctx) return {}
  return {
    id: ctx.id,
    "aria-describedby": ctx.describedBy,
    "aria-invalid": ctx.invalid || undefined,
    "aria-required": ctx.required || undefined,
  }
}

/** Wire a control the same way Field does, for layouts that place their own label (DetailList). */
export function FieldControlProvider({
  id,
  describedBy,
  invalid = false,
  required = false,
  children,
}: {
  id: string
  describedBy?: string
  invalid?: boolean
  required?: boolean
  children: React.ReactNode
}) {
  return <FieldContext.Provider value={{ id, describedBy, invalid, required }}>{children}</FieldContext.Provider>
}

/**
 * Label on top, control, then one line below: the error if there is one,
 * otherwise a short hint. Longer explanations go behind the ⓘ (`info`),
 * not as permanent text.
 */
export function Field({
  label,
  required,
  hint,
  info,
  error,
  id: idProp,
  className,
  children,
}: {
  label: React.ReactNode
  required?: boolean
  hint?: React.ReactNode
  info?: React.ReactNode
  error?: React.ReactNode
  id?: string
  className?: string
  children: React.ReactNode
}) {
  const auto = React.useId()
  const id = idProp ?? auto
  const noteId = `${id}-note`
  const note = error ?? hint
  return (
    <FieldContext.Provider value={{ id, describedBy: note ? noteId : undefined, invalid: !!error, required: !!required }}>
      <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
        <div className="flex items-center gap-1">
          <label id={`${id}-label`} htmlFor={id} className="text-small font-medium text-foreground">
            {label}
            {required && (
              <span className="ml-0.5 text-destructive" aria-hidden>
                *
              </span>
            )}
          </label>
          {info && (
            <Tooltip content={info}>
              <button
                type="button"
                aria-label={s().moreInfo}
                className="inline-grid size-4 place-items-center rounded-full text-faint-foreground hover:text-foreground [&_svg]:size-3.5"
              >
                <Info />
              </button>
            </Tooltip>
          )}
        </div>
        {children}
        {note && (
          <p
            id={noteId}
            aria-live={error ? "polite" : undefined}
            className={cn(
              "flex items-start gap-1 text-caption",
              error ? "text-destructive" : "text-faint-foreground",
            )}
          >
            {error && <CircleAlert className="mt-0.5 size-3.5" />}
            <span>{note}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  )
}

/** Vertical stack of fields; 16px between fields, 32px between groups. */
export function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4", className)} {...props} />
}
