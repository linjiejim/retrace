import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Tab } from "@/hooks/queries"

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} })

const { commands, pickRow } = await import("./commands")
const { ui } = await import("./store")
const { targetOf } = await import("@/hooks/use-project-view")
const initial = ui.get()
const tab: Tab = {
  key: "tree:/repo/linked",
  kind: "tree",
  label: "feature",
  head: "head",
  tree: { path: "/repo/linked", branch: "feature", head: "head", isMain: false, bare: false, locked: false, prunable: false },
}

beforeEach(() => ui.set(initial))
afterAll(() => vi.unstubAllGlobals())

describe("graph selection", () => {
  it("deselects an open commit and returns the changes target to the current worktree", () => {
    ui.set({ selection: { kind: "commit", hash: "abc" }, diffOpen: true, focusMode: true, file: { path: "old.ts", oldPath: null } })

    pickRow({ kind: "commit", hash: "abc" })

    expect(ui.get()).toMatchObject({ selection: null, file: null, diffOpen: false, focusMode: false, focusArea: "graph" })
    expect(targetOf(ui.get().selection, tab, null)).toEqual({ kind: "worktree", tree: "/repo/linked" })
  })

  it("opens a selected commit whose diff is closed", () => {
    ui.set({ selection: { kind: "commit", hash: "abc" } })

    pickRow({ kind: "commit", hash: "abc" })

    expect(ui.get()).toMatchObject({ selection: { kind: "commit", hash: "abc" }, diffOpen: true })
  })

  it("can select another commit and select it again after deselecting", () => {
    pickRow({ kind: "commit", hash: "abc" })
    pickRow({ kind: "commit", hash: "def" })
    expect(targetOf(ui.get().selection, tab, null)).toEqual({ kind: "commit", hash: "def" })
    pickRow({ kind: "commit", hash: "def" })
    expect(ui.get().selection).toBeNull()
    pickRow({ kind: "commit", hash: "def" })
    expect(ui.get()).toMatchObject({ selection: { kind: "commit", hash: "def" }, diffOpen: true })
  })

  it.each(["worktree", "compare"] as const)("also deselects an open %s row", (kind) => {
    ui.set({ selection: { kind }, diffOpen: true })
    pickRow({ kind })
    expect(ui.get().selection).toBeNull()
    expect(targetOf(ui.get().selection, tab, null)).toEqual({ kind: "worktree", tree: "/repo/linked" })
  })

  it("can focus uncommitted changes with no graph row selected", () => {
    ui.set({ projectId: "/repo", selection: null })
    commands.toggleFocus()
    expect(ui.get()).toMatchObject({ selection: null, diffOpen: true, focusMode: true })
    commands.toggleFocus()
    expect(ui.get().focusMode).toBe(false)
  })
})

describe("unselected changes target", () => {
  it("uses the worktree even when there are no uncommitted files or commits", () => {
    expect(targetOf(null, { ...tab, head: null }, null)).toEqual({ kind: "worktree", tree: "/repo/linked" })
  })

  it("does not invent a worktree for a branch without one", () => {
    expect(targetOf(null, { key: "branch:feature", kind: "branch", label: "feature", head: "head" }, null)).toBeNull()
    expect(targetOf(null, undefined, null)).toBeNull()
  })
})
