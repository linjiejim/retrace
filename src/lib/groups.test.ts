import { describe, expect, it } from "vitest"
import { buildRows, dropTarget, moveProject, sections } from "./groups"
import type { Group, Project } from "./types"

const p = (id: string, group: string | null = null): Project => ({ id, name: id, trunkOverride: null, group })
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

  it("moves a project into, within and out of groups", () => {
    const all = sections(projects, groups)
    expect(moveProject(all, "a", { group: "g1", before: "d" })).toEqual(["b", "a", "d", "c", "e"])
    expect(moveProject(all, "b", { group: null, before: null })).toEqual(["d", "c", "a", "e", "b"])
    expect(moveProject(all, "d", { group: "g1", before: "b" })).toEqual(["d", "b", "c", "a", "e"])
    // Dropped right above itself: nothing changes.
    expect(moveProject(all, "b", { group: "g1", before: "b" })).toEqual(["b", "d", "c", "a", "e"])
  })
})
