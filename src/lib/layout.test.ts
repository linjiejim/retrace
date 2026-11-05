import { describe, expect, it } from "vitest"
import { DEFAULT_LAYOUT, MIN_SIZE, edgesOf, isValid, minSize, movePanel, panelsIn, removePanel, resize, type Node } from "./layout"

const ids = (n: Node) => panelsIn(n).sort()

describe("layout", () => {
  it("the default layout holds each view exactly once", () => {
    expect(isValid(DEFAULT_LAYOUT)).toBe(true)
  })

  it("rejects broken stored layouts", () => {
    expect(isValid(null)).toBe(false)
    expect(isValid({ type: "panel", id: "diff" })).toBe(false)
    expect(isValid({ type: "split", dir: "row", children: [{ node: { type: "panel", id: "diff" }, size: 1 }] })).toBe(false)
  })

  it("docking keeps every view once and stays valid", () => {
    let l = DEFAULT_LAYOUT
    for (const [id, target, side] of [
      ["diff", "projects", "right"],
      ["projects", "diff", "bottom"],
      ["changes", "graph", "center"],
      ["graph", "changes", "top"],
      ["projects", "graph", "left"],
    ] as const) {
      l = movePanel(l, id, target, side)
      expect(isValid(l), `${id} → ${target} ${side}`).toBe(true)
      expect(ids(l)).toEqual(["changes", "diff", "graph", "projects"])
    }
  })

  it("docks on the requested side", () => {
    const l = movePanel(DEFAULT_LAYOUT, "diff", "graph", "top")
    const edges = edgesOf(l)
    expect(edges.get("projects")).toEqual({ top: true, left: true })
    expect(edges.get("diff")).toEqual({ top: true, left: false })
    expect(edges.get("graph")).toEqual({ top: false, left: false })
  })

  it("knows which views touch the top-left corner", () => {
    const e = edgesOf(DEFAULT_LAYOUT)
    expect(e.get("projects")).toEqual({ top: true, left: true })
    expect(e.get("graph")).toEqual({ top: true, left: false })
    expect(e.get("changes")).toEqual({ top: false, left: true })
    expect(e.get("diff")).toEqual({ top: false, left: false })
    const hidden = removePanel(DEFAULT_LAYOUT, "projects")!
    expect(edgesOf(hidden).get("changes")).toEqual({ top: true, left: true })
  })

  it("moving the projects view into a row keeps it narrow", () => {
    const l = movePanel(DEFAULT_LAYOUT, "projects", "diff", "right")
    const find = (n: Node): { size: number; fixed?: boolean } | null => {
      if (n.type === "panel") return null
      for (const c of n.children) {
        if (c.node.type === "panel" && c.node.id === "projects") return c
        const f = find(c.node)
        if (f) return f
      }
      return null
    }
    expect(find(l)).toMatchObject({ size: 220, fixed: true })
  })

  it("minimum sizes add up along a split and overlap across it", () => {
    const { projects, changes, graph, diff } = MIN_SIZE
    // Left column | right column: widths add, heights take the taller column.
    expect(minSize(DEFAULT_LAYOUT, "row")).toBe(Math.max(projects.w, changes.w) + Math.max(graph.w, diff.w) + 1)
    expect(minSize(DEFAULT_LAYOUT, "column")).toBe(Math.max(projects.h + changes.h + 1, graph.h + diff.h + 1))
    // A hidden view takes nothing.
    expect(minSize(DEFAULT_LAYOUT, "column", new Set(["diff"]))).toBe(projects.h + changes.h + 1)
  })

  it("resizing never squeezes either side below its minimum", () => {
    const shrink = resize(DEFAULT_LAYOUT, [], 0, 1, -500, [260, 1000], [220, 320])
    if (shrink.type !== "split") throw new Error()
    expect(shrink.children[0].size).toBe(220)
    const grow = resize(DEFAULT_LAYOUT, [], 0, 1, 5000, [260, 1000], [220, 320])
    if (grow.type !== "split") throw new Error()
    expect(grow.children[0].size).toBe(260 + 1000 - 320)
  })
})
