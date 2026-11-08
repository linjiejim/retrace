import { describe, expect, it } from "vitest"
import { PINNED, buildRows, dropTarget, groupGaps, moveGroup, moveProject, sections } from "./groups"
import type { Group, Project } from "./types"

const p = (id: string, group: string | null = null, pinned = false): Project => ({ id, name: id, trunkOverride: null, group, pinned })
const groups: Group[] = [
  { id: "g1", name: "Work" },
  { id: "g2", name: "Side" },
]
const projects = [p("a"), p("b", "g1"), p("c", "g2"), p("d", "g1"), p("e", "gone")]

describe("groups", () => {
  it("lists groups first, then ungrouped projects; unknown groups count as ungrouped", () => {
    expect(sections(projects, groups)).toEqual([
      { group: "g1", ids: ["b", "d"] },
      { group: "g2", ids: ["c"] },
      { group: null, ids: ["a", "e"] },
    ])
  })

  it("folds collapsed groups and marks empty open ones", () => {
    const rows = buildRows(projects, [...groups, { id: "g3", name: "New" }], new Set(["g2"]))
    expect(rows.map((r) => (r.kind === "group" ? `[${r.group.id}:${r.count}]` : r.kind === "empty" ? `(${r.group})` : r.project.id))).toEqual([
      "[g1:2]",
      "b",
      "d",
      "[g2:1]",
      "[g3:0]",
      "(g3)",
      "a",
      "e",
    ])
  })

  it("finds where a drop lands", () => {
    const all = sections(projects, groups)
    const rows = buildRows(projects, groups, new Set(["g2"]))
    // rows: [g1] b d [g2] a e
    expect(dropTarget(rows, all, 1, false)).toEqual({ group: "g1", before: "b" })
    expect(dropTarget(rows, all, 3, false)).toEqual({ group: "g1", before: null }) // after d, above a header
    expect(dropTarget(rows, all, 4, false)).toEqual({ group: null, before: "a" }) // under a folded header…
    expect(dropTarget(rows, all, 4, true)).toEqual({ group: "g2", before: null }) // …indented: into it
    expect(dropTarget(rows, all, 6, false)).toEqual({ group: null, before: null }) // the end
    const open = buildRows(projects, groups, new Set())
    // rows: [g1] b d [g2] c a e — between c and a the pointer decides
    expect(dropTarget(open, all, 5, false)).toEqual({ group: null, before: "a" })
    expect(dropTarget(open, all, 5, true)).toEqual({ group: "g2", before: null })
  })

  it("lists pinned projects first, out of their own groups", () => {
    const withPins = [...projects, p("f", "g1", true), p("g", null, true)]
    expect(sections(withPins, groups)).toEqual([
      { group: PINNED, ids: ["f", "g"] },
      { group: "g1", ids: ["b", "d"] },
      { group: "g2", ids: ["c"] },
      { group: null, ids: ["a", "e"] },
    ])
    const rows = buildRows(withPins, groups, new Set(["g2"]))
    expect(rows.map((r) => (r.kind === "group" ? `[${r.group.id}:${r.count}]` : r.kind === "empty" ? `(${r.group})` : r.project.id))).toEqual([
      `[${PINNED}:2]`,
      "f",
      "g",
      "[g1:2]",
      "b",
      "d",
      "[g2:1]",
      "a",
      "e",
    ])
    // Dragged between the pinned ones: it lands there.
    expect(dropTarget(rows, sections(withPins, groups), 2, false)).toEqual({ group: PINNED, before: "g" })
  })

  it("finds the gaps between groups and moves a group", () => {
    const withPins = [...projects, p("f", "g1", true)]
    const rows = buildRows(withPins, [...groups, { id: "g3", name: "New" }], new Set(["g2"]))
    // rows: [pinned] f [g1] b d [g2] [g3] (g3) a e
    expect(groupGaps(rows)).toEqual([
      { before: "g1", row: 2 },
      { before: "g2", row: 5 },
      { before: "g3", row: 6 },
      { before: null, row: 8 },
    ])
    expect(groupGaps(buildRows([p("a")], [], new Set()))).toEqual([])
    const order = ["g1", "g2", "g3"]
    expect(moveGroup(order, "g1", { before: null, row: 8 })).toEqual(["g2", "g3", "g1"])
    expect(moveGroup(order, "g3", { before: "g1", row: 2 })).toEqual(["g3", "g1", "g2"])
    expect(moveGroup(order, "g2", { before: "g2", row: 5 })).toEqual(order)
    expect(moveGroup(order, "g2", { before: "g3", row: 6 })).toEqual(order)
  })

  it("moves a project into, within and out of groups", () => {
    const all = sections(projects, groups)
    expect(moveProject(all, "a", { group: "g1", before: "d" })).toEqual(["b", "a", "d", "c", "e"])
    expect(moveProject(all, "b", { group: null, before: null })).toEqual(["d", "c", "a", "e", "b"])
    expect(moveProject(all, "d", { group: "g1", before: "b" })).toEqual(["d", "b", "c", "a", "e"])
    // Dropped right above itself: nothing changes.
    expect(moveProject(all, "b", { group: "g1", before: "b" })).toEqual(["b", "d", "c", "a", "e"])
  })
})
