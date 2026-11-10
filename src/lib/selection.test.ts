import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Tab } from "@/hooks/queries"
import type { Overview, PullRequest, Trunk } from "./types"

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} })

const { commands, openPullRequest, pickRow } = await import("./commands")
const { buildTabs, compareOf } = await import("@/hooks/queries")
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

describe("pull request tab", () => {
  const trunk = { name: "main", tip: "trunktip" } as Trunk
  const pr = { number: 7, title: "Stacked", headRefOid: "prhead", baseRefOid: "prbase", baseRefName: "feat/base" } as PullRequest
  const overview = { trees: [], branches: [], trunk } as unknown as Overview

  it("is listed while it loads, with no head until its commits are here", () => {
    const [loading] = buildTabs(overview, [], [], { number: 7, pr: undefined, prepared: undefined }).filter((t) => t.kind === "pr")
    expect(loading).toMatchObject({ key: "pr:7", label: "#7", head: null })
    expect(targetOf({ kind: "compare" }, loading, trunk)).toBeNull()
    expect(compareOf(loading, undefined)).toBeNull()

    const [ready] = buildTabs(overview, [], [], { number: 7, pr, prepared: { ahead: 3 } }).filter((t) => t.kind === "pr")
    expect(ready).toMatchObject({ label: "#7 Stacked", head: "prhead" })
    expect(compareOf(ready, undefined)).toEqual({ ahead: 3, behind: 0, integration: "none" })
  })

  it("compares with the pull request's own base, not the trunk", () => {
    const tab: Tab = { key: "pr:7", kind: "pr", label: "#7", head: "prhead", prNumber: 7, pr, prepared: { ahead: 3 } }
    expect(targetOf({ kind: "compare" }, tab, trunk)).toEqual({ kind: "compare", base: "prbase", tip: "prhead" })
    expect(targetOf({ kind: "commit", hash: "c1" }, tab, trunk)).toEqual({ kind: "commit", hash: "c1" })
    expect(targetOf(null, tab, trunk)).toBeNull()
  })

  it("opens with the diff shown, and picking it again brings its change back", () => {
    ui.set({ projectId: "/repo", tabs: {}, prTabs: {} })
    openPullRequest(7)
    expect(ui.get()).toMatchObject({ tabs: { "/repo": "pr:7" }, prTabs: { "/repo": 7 }, selection: null, diffOpen: true })

    ui.set({ selection: null, diffOpen: false })
    openPullRequest(7)
    expect(ui.get()).toMatchObject({ selection: { kind: "compare" }, diffOpen: true })

    ui.set({ selection: { kind: "commit", hash: "c1" } })
    openPullRequest(7)
    expect(ui.get().selection).toEqual({ kind: "commit", hash: "c1" })
  })
})
