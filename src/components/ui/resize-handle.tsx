"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"

/**
 * The edge of a panel the user drags to resize it: a docked inspector, a side
 * column, a split view. `side` is the panel edge it sits on (a right-hand
 * panel's handle is on its "left"); the panel needs `position: relative`.
 *
 * Drag it, or focus it and use the arrow keys (16px a step; Home / End go to
 * min / max). Double-click resets to `defaultValue` when one is given.
 * `onValueChange` runs while dragging; `onValueCommit` once a change is done
 * (pointer up, a key, a reset): store the size there, per place.
 */
export function ResizeHandle({
  side,
  value,
  min,
  max,
  defaultValue,
  step = 16,
  label,
  onValueChange,
  onValueCommit,
  className,
}: {
  side: "left" | "right" | "top" | "bottom"
  /** The panel's size along the drag, in px. */
  value: number
  min: number
  max: number
  /** Double-click resets to it. */
  defaultValue?: number
  step?: number
  /** Accessible name; defaults to 「调整宽度」. */
  label?: string
  onValueChange: (value: number) => void
  onValueCommit?: (value: number) => void
  className?: string
}) {
  const vertical = side === "left" || side === "right"
  // pointer moving away from the panel grows it: right / bottom edges grow with +x / +y
  const sign = side === "right" || side === "bottom" ? 1 : -1
  const grow = { left: "ArrowLeft", right: "ArrowRight", top: "ArrowUp", bottom: "ArrowDown" }[side]
  const shrink = { left: "ArrowRight", right: "ArrowLeft", top: "ArrowDown", bottom: "ArrowUp" }[side]
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)))
  const drag = React.useRef<{ at: number; from: number; now: number } | null>(null)
  const [dragging, setDragging] = React.useState(false)
  // the page's cursor before a drag, put back however the drag ends (even by unmounting mid-drag)
  const pageCursor = React.useRef<string | null>(null)
  const restoreCursor = () => {
    if (pageCursor.current === null) return
    document.documentElement.style.cursor = pageCursor.current
    pageCursor.current = null
  }
  React.useEffect(
    () => () => {
      if (pageCursor.current !== null) document.documentElement.style.cursor = pageCursor.current
    },
    [],
  )

  const commit = (v: number) => {
    // mid-drag the pointer owns the size: a key or double-click now would be undone on release
    if (drag.current) return
    const next = clamp(v)
    onValueChange(next)
    onValueCommit?.(next)
  }
  const end = () => {
    if (!drag.current) return
    const last = drag.current.now
    drag.current = null
    setDragging(false)
    restoreCursor()
    onValueCommit?.(last)
  }

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label ?? s().resizePanel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        // take focus (so the arrow keys work next), but no text selection while dragging
        e.currentTarget.focus({ preventScroll: true })
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { at: vertical ? e.clientX : e.clientY, from: value, now: value }
        setDragging(true)
        // keep the resize cursor when the pointer runs ahead of the handle
        restoreCursor()
        pageCursor.current = document.documentElement.style.cursor
        document.documentElement.style.cursor = vertical ? "col-resize" : "row-resize"
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const moved = (vertical ? e.clientX : e.clientY) - drag.current.at
        const next = clamp(drag.current.from + sign * moved)
        if (next === drag.current.now) return
        drag.current.now = next
        onValueChange(next)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={defaultValue === undefined ? undefined : () => commit(defaultValue)}
      onKeyDown={(e) => {
        if (e.key === grow) commit(value + step)
        else if (e.key === shrink) commit(value - step)
        else if (e.key === "Home") commit(min)
        else if (e.key === "End") commit(max)
        else return
        e.preventDefault()
        // pages often bind arrows (list navigation): the handle keeps its keys
        e.stopPropagation()
      }}
      className={cn(
        "absolute z-10 touch-none outline-none",
        vertical ? "inset-y-0 w-2 cursor-col-resize" : "inset-x-0 h-2 cursor-row-resize",
        { left: "-left-1", right: "-right-1", top: "-top-1", bottom: "-bottom-1" }[side],
        "after:absolute after:transition-colors after:duration-(--duration-fast)",
        vertical ? "after:inset-y-0 after:left-[3px] after:w-0.5" : "after:inset-x-0 after:top-[3px] after:h-0.5",
        "hover:after:bg-input focus-visible:after:bg-ring data-dragging:after:bg-ring",
        className,
      )}
    />
  )
}
