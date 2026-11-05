// The window is a tree of splits with the four views as leaves; every view appears exactly once.
// Views move by docking onto another view's edge (or swapping with it); splitters resize siblings.

export type PanelId = "projects" | "changes" | "graph" | "diff"
export const PANELS: PanelId[] = ["projects", "changes", "graph", "diff"]
export const PANEL_TITLE: Record<PanelId, string> = { projects: "项目", changes: "改动", graph: "提交图", diff: "diff" }

export type Dir = "row" | "column"
/** `fixed`: size is in px; otherwise a flex weight shared with the siblings. */
export interface Child {
  node: Node
  size: number
  fixed?: boolean
}
export type Node = { type: "panel"; id: PanelId } | { type: "split"; dir: Dir; children: Child[] }
export type Side = "left" | "right" | "top" | "bottom" | "center"

/** Width of the projects view when it is docked into a row on its own. */
export const PROJECTS_WIDTH = 220
/** Width of the default left column (projects over changes). */
export const LEFT_WIDTH = 300

/** Smallest each view can get, in px. Splits add these up along their axis (see `minSize`). */
export const MIN_SIZE: Record<PanelId, { w: number; h: number }> = {
  projects: { w: 160, h: 96 },
  changes: { w: 220, h: 140 },
  graph: { w: 320, h: 140 },
  diff: { w: 320, h: 160 },
}

const panel = (id: PanelId): Node => ({ type: "panel", id })
const split = (dir: Dir, children: Child[]): Node => ({ type: "split", dir, children })

/** Projects over changes on the left, the graph over the diff on the right. */
export const DEFAULT_LAYOUT: Node = split("row", [
  { node: split("column", [{ node: panel("projects"), size: 0.36 }, { node: panel("changes"), size: 0.64 }]), size: LEFT_WIDTH, fixed: true },
  { node: split("column", [{ node: panel("graph"), size: 0.38 }, { node: panel("diff"), size: 0.62 }]), size: 1 },
])

const NO_HIDDEN: ReadonlySet<PanelId> = new Set()

/** Smallest size of `node` along `axis` ("row" = width, "column" = height); hidden views count as 0. */
export function minSize(node: Node, axis: Dir, hidden: ReadonlySet<PanelId> = NO_HIDDEN): number {
  if (node.type === "panel") return hidden.has(node.id) ? 0 : axis === "row" ? MIN_SIZE[node.id].w : MIN_SIZE[node.id].h
  const mins = node.children.map((c) => minSize(c.node, axis, hidden)).filter((m) => m > 0)
  if (mins.length === 0) return 0
  // Along the split's own axis the children sit side by side (plus 1px dividers); across it they overlap.
  return node.dir === axis ? mins.reduce((a, b) => a + b, 0) + mins.length - 1 : Math.max(...mins)
}

export function panelsIn(node: Node, out: PanelId[] = []): PanelId[] {
  if (node.type === "panel") out.push(node.id)
  else node.children.forEach((c) => panelsIn(c.node, out))
  return out
}

/** Every view exactly once, sane sizes. Anything else (old or hand-edited storage) is rejected. */
export function isValid(node: unknown): node is Node {
  const ok = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false
    const x = n as Record<string, unknown>
    if (x.type === "panel") return PANELS.includes(x.id as PanelId)
    if (x.type !== "split" || (x.dir !== "row" && x.dir !== "column") || !Array.isArray(x.children) || x.children.length < 2) return false
    return x.children.every((c) => c && typeof c === "object" && Number.isFinite((c as Child).size) && (c as Child).size > 0 && ok((c as Child).node))
  }
  if (!ok(node)) return false
  const ids = panelsIn(node as Node)
  return ids.length === PANELS.length && PANELS.every((p) => ids.includes(p))
}

/** Collapse one-child splits and lift same-direction nested splits into their parent. */
export function normalize(node: Node): Node {
  if (node.type === "panel") return node
  const children: Child[] = []
  for (const c of node.children) {
    const n = normalize(c.node)
    if (n.type === "split" && n.dir === node.dir && !c.fixed) {
      // Spread the slot's weight over the lifted children; fixed grandchildren keep their px.
      const weights = n.children.filter((g) => !g.fixed).reduce((s, g) => s + g.size, 0) || 1
      for (const g of n.children) children.push(g.fixed ? g : { ...g, size: (g.size / weights) * c.size })
    } else {
      children.push({ ...c, node: n })
    }
  }
  if (children.length === 1) return children[0].node
  return { type: "split", dir: node.dir, children }
}

/** The tree without `id` (its siblings take the space). */
export function removePanel(node: Node, id: PanelId): Node | null {
  if (node.type === "panel") return node.id === id ? null : node
  const children = node.children.flatMap((c) => {
    const n = removePanel(c.node, id)
    return n ? [{ ...c, node: n }] : []
  })
  if (children.length === 0) return null
  // If only fixed children remain, let the last one stretch.
  if (children.every((c) => c.fixed)) children[children.length - 1] = { ...children[children.length - 1], fixed: false, size: 1 }
  return normalize({ type: "split", dir: node.dir, children })
}

function sizeFor(id: PanelId, dir: Dir, next: Child): Omit<Child, "node"> {
  if (id === "projects" && dir === "row") return { size: PROJECTS_WIDTH, fixed: true }
  return next.fixed ? { size: 1 } : { size: next.size / 2 }
}

/** Put `id` on `side` of `target` (`center` swaps the two). */
export function movePanel(root: Node, id: PanelId, target: PanelId, side: Side): Node {
  if (id === target) return root
  if (side === "center") return swapPanels(root, id, target)
  const without = removePanel(root, id)
  if (!without) return root
  const dir: Dir = side === "left" || side === "right" ? "row" : "column"
  const before = side === "left" || side === "top"
  const insert = (node: Node): Node => {
    if (node.type === "panel") {
      if (node.id !== target) return node
      // Target is the root (or a lone leaf): wrap it.
      const own: Child = { node, size: 1 }
      const added: Child = { node: panel(id), ...sizeFor(id, dir, own) }
      if (!added.fixed) own.size = added.size
      return split(dir, before ? [added, own] : [own, added])
    }
    const children: Child[] = []
    for (const c of node.children) {
      if (c.node.type === "panel" && c.node.id === target) {
        if (node.dir === dir) {
          const added: Child = { node: panel(id), ...sizeFor(id, dir, c) }
          const kept: Child = !added.fixed && !c.fixed ? { ...c, size: c.size / 2 } : c
          children.push(...(before ? [added, kept] : [kept, added]))
        } else {
          // Split the target's slot across the other axis; the slot keeps its size.
          const inner: Child[] = [{ node: c.node, size: 1 }, { node: panel(id), size: 1 }]
          if (id === "projects" && dir === "row") inner[1] = { node: panel(id), size: PROJECTS_WIDTH, fixed: true }
          children.push({ ...c, node: split(dir, before ? inner.reverse() : inner) })
        }
      } else {
        children.push({ ...c, node: insert(c.node) })
      }
    }
    return { ...node, children }
  }
  return normalize(insert(without))
}

export function swapPanels(root: Node, a: PanelId, b: PanelId): Node {
  const swap = (node: Node): Node => {
    if (node.type === "panel") return node.id === a ? panel(b) : node.id === b ? panel(a) : node
    return { ...node, children: node.children.map((c) => ({ ...c, node: swap(c.node) })) }
  }
  return swap(root)
}

export interface Edges {
  top: boolean
  left: boolean
}

/** Which views touch the window's top edge and left edge (title bar and traffic lights). */
export function edgesOf(node: Node, at: Edges = { top: true, left: true }, out = new Map<PanelId, Edges>()): Map<PanelId, Edges> {
  if (node.type === "panel") {
    out.set(node.id, at)
    return out
  }
  node.children.forEach((c, i) => {
    const first = i === 0
    edgesOf(c.node, { top: at.top && (node.dir === "row" || first), left: at.left && (node.dir === "column" || first) }, out)
  })
  return out
}

/** Move the boundary between children `a` and `b` (visible neighbours) of the split at `path` by
 *  `delta` px, given their current pixel sizes and minimum sizes. */
export function resize(root: Node, path: number[], a: number, b: number, delta: number, px: [number, number], min: [number, number] = [0, 0]): Node {
  const apply = (node: Node, depth: number): Node => {
    if (node.type !== "split") return node
    if (depth < path.length) {
      return { ...node, children: node.children.map((c, k) => (k === path[depth] ? { ...c, node: apply(c.node, depth + 1) } : c)) }
    }
    const ca = node.children[a]
    const cb = node.children[b]
    // Both sides stay at or above their own minimum.
    const lo = min[0] - px[0]
    const hi = px[1] - min[1]
    const d = lo > hi ? 0 : Math.max(lo, Math.min(hi, delta))
    const [pa, pb] = [px[0] + d, px[1] - d]
    let na: Child = ca.fixed ? { ...ca, size: pa } : ca
    let nb: Child = cb.fixed ? { ...cb, size: pb } : cb
    if (!ca.fixed && !cb.fixed) {
      const total = ca.size + cb.size
      na = { ...ca, size: (total * pa) / (pa + pb) }
      nb = { ...cb, size: (total * pb) / (pa + pb) }
    }
    const children = [...node.children]
    children[a] = na
    children[b] = nb
    return { ...node, children }
  }
  return apply(root, 0)
}
