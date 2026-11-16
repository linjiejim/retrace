import { beforeEach, expect, it, vi } from "vitest"
vi.hoisted(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})
const api = vi.hoisted(() => ({ changes: vi.fn(), treeStatuses: vi.fn(), overview: vi.fn() }))
vi.mock("./api", () => ({ api, inTauri: true, pickFolders: vi.fn() }))
vi.mock("./terminals", () => ({ focusTerminal: vi.fn() }))
vi.mock("./updater", () => ({ checkForUpdates: vi.fn() }))
vi.mock("./quit", () => ({ leave: vi.fn() }))
vi.mock("@/components/ui/toast", () => ({ notify: { info: vi.fn(), error: vi.fn() } }))
import { commands, openSessionFile } from "./commands"
import { queryClient } from "./query"
import { ui } from "./store"

const session = { project: "/repo", tree: "/repo.worktrees/fix" }

beforeEach(() => {
  vi.resetAllMocks()
  queryClient.clear()
  // A failed read is retried once after a second in the app; here it fails at once.
  queryClient.setDefaultOptions({ queries: { retry: false } })
  ui.set({ projectId: "/other", tabs: {}, selection: null, file: null, wanted: null, newAgent: null })
})

it("reads the worktree's status and HEAD again before it asks for an agent's file", async () => {
  // Cached from before the agent wrote the file: nothing uncommitted, the old HEAD.
  queryClient.setQueryData(["statuses", "/repo"], [{ path: session.tree, files: 0 }])
  queryClient.setQueryData(["overview", "/repo"], { trees: [{ path: session.tree, head: "old" }] })
  api.changes.mockResolvedValue([{ path: "src/cart.ts" }])
  api.treeStatuses.mockResolvedValue([{ path: session.tree, files: 1 }])
  api.overview.mockResolvedValue({ trees: [{ path: session.tree, head: "new" }] })
  // What the tab's default selection would judge the request by, the moment it is made.
  let seen: unknown[] | null = null
  const off = ui.subscribe(() => {
    if (ui.get().wanted && !seen) seen = [queryClient.getQueryData(["statuses", "/repo"]), queryClient.getQueryData(["overview", "/repo"])]
  })
  await openSessionFile(session, "src/cart.ts")
  off()
  expect(seen).toEqual([[{ path: session.tree, files: 1 }], { trees: [{ path: session.tree, head: "new" }] }])
  expect(ui.get().projectId).toBe("/repo")
  expect(ui.get().wanted).toMatchObject({ key: `/repo\0tree:${session.tree}`, selection: { kind: "worktree" }, file: { path: "src/cart.ts", oldPath: null } })
})

it("still opens the file when the status can't be read, as part of the branch once it is committed", async () => {
  api.changes.mockResolvedValue([])
  api.treeStatuses.mockRejectedValue(new Error("git status failed"))
  api.overview.mockRejectedValue(new Error("git failed"))
  await openSessionFile(session, "src/cart.ts")
  expect(ui.get().wanted).toMatchObject({ selection: { kind: "compare" }, file: { path: "src/cart.ts", oldPath: null } })
})

it("leaves the new-session dialog as it is when ⌘N comes again while it is open", () => {
  const open = { projectId: "/repo" }
  ui.set({ newAgent: open })
  commands.newAgent()
  expect(ui.get().newAgent).toBe(open)
  ui.set({ newAgent: null })
  commands.newAgent()
  expect(ui.get().newAgent).toEqual({ projectId: "/other" })
})
