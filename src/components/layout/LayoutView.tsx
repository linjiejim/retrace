import { createContext, Fragment, useContext, useMemo, useRef, type ReactNode } from "react"
import { GripVertical } from "lucide-react"
import { edgesOf, minSize, movePanel, PANEL_TITLE, removePanel, resize, type Edges, type Node, type PanelId, type Side } from "@/lib/layout"
import { createStore, prefs, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { t } from "@/lib/i18n"
import { Tooltip } from "@/components/ui/tooltip"

interface PanelInfo extends Edges {
  id: PanelId
  /** False for temporary layouts (focus mode): no grips, no resizing, nothing saved. */
  editable: boolean
}
const PanelContext = createContext<PanelInfo>({ id: "graph", top: true, left: true, editable: true })
export const usePanel = () => useContext(PanelContext)

const drag = createStore<{ id: PanelId | null; target: PanelId | null; side: Side | null; x: number; y: number }>({
  id: null,
  target: null,
  side: null,
  x: 0,
  y: 0,
})

/** Which part of a view the pointer is over: the middle swaps, the edges dock. */
function sideAt(rect: DOMRect, x: number, y: number): Side {
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return "center"
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  return (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[a] <= d[b] ? a : b))
}

function startDrag(id: PanelId, e: React.PointerEvent) {
  e.preventDefault()
  drag.set({ id, target: null, side: null, x: e.clientX, y: e.clientY })
  document.body.style.cursor = "grabbing"
  const move = (ev: PointerEvent) => {
    const slot = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el instanceof HTMLElement && el.dataset.panel) as HTMLElement | undefined
    const target = (slot?.dataset.panel as PanelId | undefined) ?? null
    const side = slot && target !== id ? sideAt(slot.getBoundingClientRect(), ev.clientX, ev.clientY) : null
    drag.set({ target: target !== id ? target : null, side, x: ev.clientX, y: ev.clientY })
  }
  const end = (commit: boolean) => {
    const { id: from, target, side } = drag.get()
    if (commit && from && target && side) prefs.set((p) => ({ layout: movePanel(p.layout, from, target, side) }))
    drag.set({ id: null, target: null, side: null })
    document.body.style.cursor = ""
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("keydown", key)
  }
  const up = () => end(true)
  const key = (ev: KeyboardEvent) => ev.key === "Escape" && end(false)
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("keydown", key)
}

/**
 * The bar on top of every view: title-bar height and traffic-light inset when it touches those
 * edges. It is a size container (`@container/header`), so views hide secondary controls when narrow.
 */
export function PanelHeader({ children, className }: { children?: ReactNode; className?: string }) {
  const { id, top, left, editable } = usePanel()
  return (
    <div
      data-tauri-drag-region={top || undefined}
      className={cn(
        "group/header @container/header flex min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b pr-2",
        top ? "h-[38px]" : "h-[34px]",
        top && left ? "pl-[74px]" : "pl-0.5",
        className,
      )}
    >
      {editable && <Tooltip content={t("Drag “{name}” to rearrange", { name: t(PANEL_TITLE[id]) })} delayDuration={600}>
        <button
          aria-label={t("Move “{name}”", { name: t(PANEL_TITLE[id]) })}
          onPointerDown={(e) => startDrag(id, e)}
          className="inline-flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded-xs text-faint-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100"
        >
          <GripVertical className="size-3.5" />
        </button>
      </Tooltip>}
      {children}
    </div>
  )
}

const OVERLAY: Record<Side, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  center: "inset-[12%]",
}
const SIDE_LABEL: Record<Side, string> = { left: "Dock left", right: "Dock right", top: "Dock above", bottom: "Dock below", center: "Swap places" }

/** Only this subscribes to the drag store, so dragging repaints overlays, not the views. */
function DropOverlay({ id }: { id: PanelId }) {
  const dragging = useStore(drag, (s) => s.id)
  const target = useStore(drag, (s) => s.target)
  const side = useStore(drag, (s) => s.side)
  if (!dragging || dragging === id) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {target === id && side && (
        <div className={cn("absolute flex items-center justify-center rounded-md bg-primary-subtle/90 ring-2 ring-primary transition-all duration-(--duration-fast)", OVERLAY[side])}>
          <span className="rounded-sm bg-popover px-2 py-1 text-small font-medium shadow-popover">{t(SIDE_LABEL[side])}</span>
        </div>
      )}
    </div>
  )
}

function Slot({ id, edges, editable, render }: { id: PanelId; edges: Edges; editable: boolean; render: (id: PanelId) => ReactNode }) {
  const info = useMemo(() => ({ id, editable, ...edges }), [id, editable, edges])
  const content = useMemo(() => render(id), [render, id])
  return (
    <PanelContext.Provider value={info}>
      <div data-panel={id} className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        {content}
        <DropOverlay id={id} />
      </div>
    </PanelContext.Provider>
  )
}

function DragLabel() {
  const dragging = useStore(drag, (s) => s.id)
  const x = useStore(drag, (s) => s.x)
  const y = useStore(drag, (s) => s.y)
  if (!dragging) return null
  return (
    <div className="pointer-events-none fixed z-50 rounded-sm bg-inverse px-2 py-1 text-caption text-inverse-foreground" style={{ left: x + 12, top: y + 12 }}>
      {t("Move “{name}”", { name: t(PANEL_TITLE[dragging]) })} · {t("Esc to cancel")}
    </div>
  )
}

function visible(node: Node, hidden: Set<PanelId>): boolean {
  return node.type === "panel" ? !hidden.has(node.id) : node.children.some((c) => visible(c.node, hidden))
}

function Divider(props: { dir: "row" | "column"; path: number[]; a: number; b: number; mins: [number, number]; layout: Node; editable: boolean }) {
  const { dir, path, a, b, mins, layout, editable } = props
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className={cn("relative shrink-0 bg-border", dir === "row" ? "w-px" : "h-px")}>
      {editable && <div
        role="separator"
        aria-orientation={dir === "row" ? "vertical" : "horizontal"}
        className={cn("absolute z-20", dir === "row" ? "inset-y-0 -left-1 w-2 cursor-col-resize" : "inset-x-0 -top-1 h-2 cursor-row-resize")}
        onPointerDown={(e) => {
          e.preventDefault()
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const prev = ref.current?.previousElementSibling?.getBoundingClientRect()
          const next = ref.current?.nextElementSibling?.getBoundingClientRect()
          if (!prev || !next) return
          const px: [number, number] = dir === "row" ? [prev.width, next.width] : [prev.height, next.height]
          const start = dir === "row" ? e.clientX : e.clientY
          const base = layout
          document.body.style.cursor = dir === "row" ? "col-resize" : "row-resize"
          const move = (ev: PointerEvent) => prefs.set({ layout: resize(base, path, a, b, (dir === "row" ? ev.clientX : ev.clientY) - start, px, mins) })
          const up = () => {
            document.body.style.cursor = ""
            el.removeEventListener("pointermove", move)
            el.removeEventListener("pointerup", up)
          }
          el.addEventListener("pointermove", move)
          el.addEventListener("pointerup", up)
        }}
      />}
    </div>
  )
}

function NodeView(props: {
  node: Node
  path: number[]
  layout: Node
  hidden: Set<PanelId>
  edges: Map<PanelId, Edges>
  editable: boolean
  render: (id: PanelId) => ReactNode
}) {
  const { node, path, layout, hidden, edges, editable, render } = props
  if (node.type === "panel") return <Slot id={node.id} edges={edges.get(node.id) ?? { top: false, left: false }} editable={editable} render={render} />
  const shown = node.children
    .map((c, i) => ({ c, i, w: minSize(c.node, "row", hidden), h: minSize(c.node, "column", hidden) }))
    .filter(({ c }) => visible(c.node, hidden))
  // A lone visible child of a fixed-size slot still fills the whole split.
  const lone = shown.length === 1
  // Weights of the visible slots, scaled to sum to 1: flex-grow factors summing below 1 would leave
  // space unclaimed (a view hidden next to them took the rest of the weight).
  const weight = shown.reduce((sum, { c }) => sum + (c.fixed ? 0 : c.size), 0) || 1
  const along = (s: (typeof shown)[number]) => (node.dir === "row" ? s.w : s.h)
  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0", node.dir === "row" ? "flex-row" : "flex-col")}>
      {shown.map((s, k) => {
        const { c, i } = s
        // Weighted slots share what's left from 0; fixed slots give way (down to their minimum) when
        // the window is too small; no slot goes below the minimum of what it holds.
        const flex = lone ? "1 1 0px" : c.fixed ? `0 1 ${c.size}px` : `${c.size / weight} 1 0px`
        return (
        <Fragment key={i}>
          {k > 0 && <Divider dir={node.dir} path={path} a={shown[k - 1].i} b={i} mins={[along(shown[k - 1]), along(s)]} layout={layout} editable={editable} />}
          <div className="relative overflow-hidden" style={{ flex, minWidth: s.w, minHeight: s.h }}>
            <NodeView {...props} node={c.node} path={[...path, i]} />
          </div>
        </Fragment>
        )
      })}
    </div>
  )
}

/** Renders the saved layout; `hidden` views keep their place in the tree but take no space. */
export function LayoutView({ layout, hidden, editable = true, render }: { layout: Node; hidden: PanelId[]; editable?: boolean; render: (id: PanelId) => ReactNode }) {
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const edges = useMemo(() => {
    let shown: Node | null = layout
    for (const id of hidden) shown = shown && removePanel(shown, id)
    return edgesOf(shown ?? layout)
  }, [layout, hidden])
  return (
    <>
      <NodeView node={layout} path={[]} layout={layout} hidden={hiddenSet} edges={edges} editable={editable} render={render} />
      <DragLabel />
    </>
  )
}
