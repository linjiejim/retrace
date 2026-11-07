// The projects list with groups: what rows it shows, and where a dragged project lands.

import type { AgentSession, Group, Project } from "./types"

/** A run of projects: one group's, or (group null) the ungrouped ones, in list order. */
export interface Section {
  group: string | null
  ids: string[]
}

export type Row =
  | { kind: "group"; group: Group; count: number; collapsed: boolean }
  | { kind: "project"; project: Project; group: string | null }
  /** An open group with nothing in it yet. */
  | { kind: "empty"; group: string }
  /** An agent session, under its project. */
  | { kind: "session"; session: AgentSession; group: string | null }

const NO_SESSIONS: ReadonlyMap<string, AgentSession[]> = new Map()

/** Each project's sessions, in the order they started. */
export function sessionsByProject(sessions: AgentSession[] | undefined): Map<string, AgentSession[]> {
  const out = new Map<string, AgentSession[]>()
  for (const s of [...(sessions ?? [])].sort((a, b) => a.startedAt - b.startedAt)) {
    const list = out.get(s.project) ?? []
    list.push(s)
    out.set(s.project, list)
  }
  return out
}

/** The project row, then its session rows. */
export function projectRows(project: Project, group: string | null, sessions: ReadonlyMap<string, AgentSession[]> = NO_SESSIONS): Row[] {
  return [{ kind: "project", project, group }, ...(sessions.get(project.id) ?? []).map((session) => ({ kind: "session" as const, session, group }))]
}

/** Groups in their order, then the ungrouped projects. A project naming a missing group is ungrouped. */
export function sections(projects: Project[], groups: Group[]): Section[] {
  const known = new Set(groups.map((g) => g.id))
  const groupOf = (p: Project) => (p.group && known.has(p.group) ? p.group : null)
  return [
    ...groups.map((g) => ({ group: g.id as string | null, ids: projects.filter((p) => groupOf(p) === g.id).map((p) => p.id) })),
    { group: null, ids: projects.filter((p) => groupOf(p) === null).map((p) => p.id) },
  ]
}

export function buildRows(projects: Project[], groups: Group[], collapsed: ReadonlySet<string>, sessions: ReadonlyMap<string, AgentSession[]> = NO_SESSIONS): Row[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const rows: Row[] = []
  for (const s of sections(projects, groups)) {
    if (s.group !== null) {
      const group = groups.find((g) => g.id === s.group)!
      const folded = collapsed.has(group.id)
      rows.push({ kind: "group", group, count: s.ids.length, collapsed: folded })
      if (folded) continue
      if (s.ids.length === 0) rows.push({ kind: "empty", group: group.id })
    }
    for (const id of s.ids) rows.push(...projectRows(byId.get(id)!, s.group, sessions))
  }
  return rows
}

/** Where a drop lands: in `group`, before the project `before` (null: at the end). */
export interface DropTarget {
  group: string | null
  before: string | null
}

/** A gap among a project's session rows moves below them: sessions stay with their project. */
export function snapGap(rows: Row[], gap: number): number {
  let g = gap
  while (rows[g]?.kind === "session") g++
  return g
}

/**
 * The drop target for the gap above `rows[gap]`. Between a group (its last project, or its folded
 * header) and the first ungrouped project the pointer decides: indented goes into the group.
 */
export function dropTarget(rows: Row[], all: Section[], gap: number, indented: boolean): DropTarget {
  const at = snapGap(rows, gap)
  // The row above, skipping the sessions of the project above.
  let above = at - 1
  while (rows[above]?.kind === "session") above--
  const prev = rows[above]
  const next = rows[at]
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
