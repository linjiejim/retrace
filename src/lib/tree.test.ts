import { describe, expect, it } from "vitest"
import { buildTree, folderPaths, visibleRows } from "./tree"
import type { FileChange } from "./types"

const f = (path: string): FileChange => ({ path, oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false })

describe("buildTree", () => {
  it("joins lone folder chains and lists folders before files", () => {
    const tree = buildTree([f("README.md"), f("apps/app/src/a.ts"), f("apps/app/src/b.ts"), f("apps/api/x.ts")])
    expect(tree.map((n) => n.name)).toEqual(["apps", "README.md"])
    const apps = tree[0]
    if (apps.kind !== "folder") throw new Error()
    expect(apps.children.map((n) => n.name)).toEqual(["api", "app/src"])
    const appSrc = apps.children[1]
    if (appSrc.kind !== "folder") throw new Error()
    expect(appSrc.path).toBe("apps/app/src")
  })

  it("hides the contents of collapsed folders", () => {
    const tree = buildTree([f("a/x.ts"), f("a/y.ts"), f("b.ts")])
    expect(visibleRows(tree, () => true).length).toBe(4)
    expect(visibleRows(tree, (p) => p !== "a").map((r) => r.node.name)).toEqual(["a", "b.ts"])
  })

  it("lists every folder, nested ones included", () => {
    const tree = buildTree([{ path: "a/b/x.ts" }, { path: "a/c/y.ts" }, { path: "z.ts" }])
    expect(folderPaths(tree)).toEqual(["a", "a/b", "a/c"])
  })
})
