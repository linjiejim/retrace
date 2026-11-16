import * as React from "react"
import { Info as InfoIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { s } from "@/lib/strings"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * ⓘ beside a title, a label or a figure, holding what the page shouldn't say
 * all the time: how a number is counted, what a setting changes, a caveat.
 *
 * Pointing at it opens it, after a short delay so passing over doesn't flash
 * it; a click, a tap or Enter pins it open until a click elsewhere or Esc.
 * Not a Tooltip: touch screens have no hover. Text only, no actions inside:
 * focus stays on the ⓘ.
 */
export function Info({
  children,
  label,
  side = "bottom",
  align = "start",
  className,
}: {
  children: React.ReactNode
  /** Accessible name of the ⓘ; defaults to 「说明」. */
  label?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  // opened by a click, a tap or Enter: the pointer leaving doesn't close it
  const pinned = React.useRef(false)
  // focus goes back to the ⓘ only when it was pinned (Esc after Enter), never after a hover
  const refocus = React.useRef(false)
  const timer = React.useRef<number | undefined>(undefined)
  const textId = React.useId()
  const cancel = () => window.clearTimeout(timer.current)
  React.useEffect(() => cancel, [])

  const hover = (e: React.PointerEvent, on: boolean) => {
    if (e.pointerType !== "mouse" || pinned.current) return
    cancel()
    timer.current = window.setTimeout(() => {
      refocus.current = false
      setOpen(on)
    }, on ? 90 : 180)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        cancel()
        if (!next) {
          refocus.current = pinned.current
          pinned.current = false
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label ?? s().moreInfo}
          // the text is portaled away from the ⓘ: say it when focus stays on the ⓘ
          aria-describedby={open ? textId : undefined}
          className={cn(
            "relative inline-grid size-5 shrink-0 place-items-center rounded-full text-faint-foreground transition-colors duration-(--duration-fast) hover:text-foreground [&_svg]:size-3.5",
            "after:absolute pointer-coarse:after:-inset-3",
            open && "text-foreground",
            className,
          )}
          onPointerEnter={(e) => hover(e, true)}
          onPointerLeave={(e) => hover(e, false)}
          onClick={(e) => {
            // Radix would toggle, so a click on an ⓘ opened by pointing would close it: pin it instead
            e.preventDefault()
            cancel()
            const close = open && pinned.current
            refocus.current = close
            pinned.current = !close
            setOpen(!close)
          }}
        >
          <InfoIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="text-small"
        aria-label={label ?? s().moreInfo}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          if (!refocus.current) e.preventDefault()
        }}
        onPointerEnter={(e) => hover(e, true)}
        onPointerLeave={(e) => hover(e, false)}
      >
        <div id={textId}>{children}</div>
      </PopoverContent>
    </Popover>
  )
}
