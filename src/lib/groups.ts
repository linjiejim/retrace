// The projects list with groups: what rows it shows, and where a dragged project lands.

import type { Group, Project } from "./types"

/**
 * The pinned projects show first, as a group of their own with this id (real group ids start with
 * "g"). A pinned project keeps its own group for when it's unpinned, and shows only here.
 */
export const PINNED = "@pinned"

/** A run of projects: one group's (or the pinned ones), or (group null) the ungrouped ones, in list order. */
export interface Section {
  group: string | null
  ids: string[]
}

export type Row =
  | { kind: "group"; group: Group; count: number; collapsed: boolean }
  | { kind: "project"; project: Project; group: string | null }
  /** An open group with nothing in it yet. */
  | { kind: "empty"; group: string }

/**
 * The pinned projects (when there are any), the groups in their order, then the ungrouped projects.
 * A project naming a missing group is ungrouped.
 */
export function sections(projects: Project[], groups: Group[]): Section[] {
  const known = new Set(groups.map((g) => g.id))
  const groupOf = (p: Project) => (p.pinned ? PINNED : p.group && known.has(p.group) ? p.group : null)
  const ids = (group: string | null) => projects.filter((p) => groupOf(p) === group).map((p) => p.id)
  const pinned = ids(PINNED)
  return [
    ...(pinned.length ? [{ group: PINNED as string | null, ids: pinned }] : []),
    ...groups.map((g) => ({ group: g.id as string | null, ids: ids(g.id) })),
    { group: null, ids: ids(null) },
  ]
}

/** Where a dragged group lands: before this group, or (null) after the last one. */
export interface GroupGap {
  before: string | null
  /** The row the gap is above, for drawing it. */
  row: number
}

/** The gaps between groups (not the pinned ones) in `rows`: above each group, and after the last. */
export function groupGaps(rows: Row[]): GroupGap[] {
  const gaps: GroupGap[] = []
  let last: string | null = null
  let end = -1
  rows.forEach((r, i) => {
    if (r.kind === "group" && r.group.id !== PINNED) {
      gaps.push({ before: r.group.id, row: i })
      last = r.group.id
      end = i + 1
    } else if (last !== null && r.kind !== "group" && r.group === last) end = i + 1
  })
  if (end >= 0) gaps.push({ before: null, row: end })
  return gaps
}

/** The group order after moving `id` to `gap`. */
export function moveGroup(order: string[], id: string, gap: GroupGap): string[] {
  if (gap.before === id) return order
  const rest = order.filter((g) => g !== id)
  const at = gap.before ? rest.indexOf(gap.before) : -1
  rest.splice(at < 0 ? rest.length : at, 0, id)
  return rest
}

export function buildRows(projects: Project[], groups: Group[], collapsed: ReadonlySet<string>): Row[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const rows: Row[] = []
  for (const s of sections(projects, groups)) {
    if (s.group !== null) {
      const group = s.group === PINNED ? { id: PINNED, name: "" } : groups.find((g) => g.id === s.group)!
      const folded = collapsed.has(group.id)
      rows.push({ kind: "group", group, count: s.ids.length, collapsed: folded })
      if (folded) continue
      if (s.ids.length === 0) rows.push({ kind: "empty", group: group.id })
    }
    for (const id of s.ids) rows.push({ kind: "project", project: byId.get(id)!, group: s.group })
  }
  return rows
}

/** Where a drop lands: in `group`, before the project `before` (null: at the end). */
export interface DropTarget {
  group: string | null
  before: string | null
}

/**
 * The drop target for the gap above `rows[gap]`. Between a group (its last project, or its folded
 * header) and the first ungrouped project the pointer decides: indented goes into the group.
 */
export function dropTarget(rows: Row[], all: Section[], gap: number, indented: boolean): DropTarget {
  const prev = rows[gap - 1]
  const next = rows[gap]
  const after = (group: string | null, id: string): DropTarget => {
    const ids = all.find((s) => s.group === group)?.ids ?? []
    return { group, before: ids[ids.indexOf(id) + 1] ?? null }
  }
  if (next?.kind === "project") {
    if (indented && next.group === null && prev?.kind === "project" && prev.group !== null) return after(prev.group, prev.project.id)
    if (indented && next.group === null && prev?.kind === "group") return { group: prev.group.id, before: null }
    return { group: next.group, before: next.project.id }
  }
  if (next?.kind === "empty") return { group: next.group, before: null }
  if (!prev) return { group: null, before: null }
  if (prev.kind === "project") return after(prev.group, prev.project.id)
  if (prev.kind === "group") return { group: prev.group.id, before: prev.collapsed ? null : (all.find((s) => s.group === prev.group.id)?.ids[0] ?? null) }
  return { group: prev.group, before: null }
}

/** The list after moving `id` to `to`: the new order of every project. */
export function moveProject(all: Section[], id: string, to: DropTarget): string[] {
  let before = to.before
  // Dropped right above itself: it stays before the project that followed it.
  if (before === id) {
    const ids = all.find((s) => s.group === to.group)?.ids ?? []
    before = ids[ids.indexOf(id) + 1] ?? null
  }
  const next = all.map((s) => ({ group: s.group, ids: s.ids.filter((x) => x !== id) }))
  const target = next.find((s) => s.group === to.group) ?? next[next.length - 1]
  const at = before ? target.ids.indexOf(before) : -1
  target.ids.splice(at < 0 ? target.ids.length : at, 0, id)
  return next.flatMap((s) => s.ids)
}
