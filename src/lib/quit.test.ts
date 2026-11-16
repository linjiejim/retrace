import { beforeEach, expect, it, vi } from "vitest"
vi.hoisted(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }) })
const mocks = vi.hoisted(() => ({ sessions: vi.fn(), stopBackground: vi.fn(), exit: vi.fn(), relaunch: vi.fn(), destroy: vi.fn(), onCloseRequested: vi.fn(), error: vi.fn() }))
vi.mock("./api", () => ({ inTauri: true, api: { agentSessions: mocks.sessions, agentStopBackground: mocks.stopBackground } }))
vi.mock("@tauri-apps/plugin-process", () => ({ exit: mocks.exit, relaunch: mocks.relaunch }))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested, destroy: mocks.destroy }) }))
vi.mock("@/components/ui/toast", () => ({ notify: { error: mocks.error } }))
import { guardWindowClose, leave, leaving, quitCounts } from "./quit"
import type { AgentSession } from "./types"
beforeEach(() => { vi.resetAllMocks(); leaving.set({ ask: null, ending: 0, continuing: 0 }) })
it("asks before exiting or restarting active sessions", async () => {
  mocks.sessions.mockResolvedValue([{ running: true }, { running: false }])
  await leave("restart")
  expect(leaving.get()).toEqual({ ask: "restart", ending: 1, continuing: 0 })
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

it("ends terminal sessions, lets background ones at work carry on, and stops them only when asked", async () => {
  const at = (more: Partial<AgentSession>) => ({ running: true, background: false, live: null, ...more }) as AgentSession
  const live = (state: string) => ({ state }) as AgentSession["live"]
  const sessions = [at({}), at({ background: true, nativeId: "a", live: live("busy") }), at({ background: true, nativeId: "b", live: live("asking") }), at({ background: true, nativeId: "c", live: live("idle") }), at({ running: false })]
  expect(quitCounts(sessions)).toEqual({ ending: 1, continuing: 2 })
  // Still in its setup command: that is Retrace's, and ends with it.
  expect(quitCounts([at({ background: true, nativeId: null, live: live("busy") })])).toEqual({ ending: 1, continuing: 0 })
  // Nothing at work: quit straight away (an idle background session just lets go).
  mocks.sessions.mockResolvedValue([at({ background: true, nativeId: "a", live: { state: "idle" } as AgentSession["live"] })])
  await leave("quit")
  expect(mocks.exit).toHaveBeenCalledOnce()
  expect(mocks.stopBackground).not.toHaveBeenCalled()
  await leave("quit", true, true)
  expect(mocks.stopBackground).toHaveBeenCalledOnce()
})
