import { beforeEach, expect, it, vi } from "vitest"
vi.hoisted(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }) })
const mocks = vi.hoisted(() => ({ sessions: vi.fn(), exit: vi.fn(), relaunch: vi.fn(), destroy: vi.fn(), onCloseRequested: vi.fn(), error: vi.fn() }))
vi.mock("./api", () => ({ inTauri: true, api: { agentSessions: mocks.sessions } }))
vi.mock("@tauri-apps/plugin-process", () => ({ exit: mocks.exit, relaunch: mocks.relaunch }))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested, destroy: mocks.destroy }) }))
vi.mock("@/components/ui/toast", () => ({ notify: { error: mocks.error } }))
import { guardWindowClose, leave, leaving } from "./quit"
beforeEach(() => { vi.resetAllMocks(); leaving.set({ ask: null, running: 0 }) })
it("asks before exiting or restarting active sessions", async () => {
  mocks.sessions.mockResolvedValue([{ running: true }, { running: false }])
  await leave("restart")
  expect(leaving.get()).toEqual({ ask: "restart", running: 1 })
  expect(mocks.relaunch).not.toHaveBeenCalled()
  await leave("restart", true)
  expect(mocks.relaunch).toHaveBeenCalledOnce()
})
it("keeps the app open when session status cannot be checked", async () => {
  mocks.sessions.mockRejectedValue(new Error("unavailable"))
  await leave("quit")
  expect(mocks.exit).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledOnce()
})
it("guards closing the window until active sessions are confirmed", async () => {
  await guardWindowClose()
  const close = mocks.onCloseRequested.mock.calls[0][0]
  const e = { preventDefault: vi.fn() }
  mocks.sessions.mockResolvedValue([{ running: true }])
  await close(e)
  expect(e.preventDefault).toHaveBeenCalledOnce()
  expect(leaving.get().ask).toBe("quit")
  expect(mocks.destroy).not.toHaveBeenCalled()
  mocks.sessions.mockResolvedValue([])
  await close(e)
  expect(mocks.destroy).toHaveBeenCalledOnce()
})
