import { describe, expect, it } from "vitest"
import { canResume, agentState, defaultBranch, fromBase64, isTerminalReport, newPart, pasted, QUIET_MS, sessionLabel, slugify, toBase64, worktreePath } from "./agent-state"
import type { AgentSession } from "./types"

const base: AgentSession = {
  id: "s1",
  project: "/p",
  tree: "/p",
  branch: null,
  agent: "opencode",
  task: "",
  title: null,
  startedAt: 0,
  lastOutputAt: 1000,
  bellAt: null,
  inputAt: null,
  running: true,
  exitCode: null,
  stopped: false,
}

describe("agent state", () => {
  it("is working while output keeps coming, waiting once it goes quiet", () => {
    expect(agentState(base, 1000 + QUIET_MS - 1)).toBe("working")
    expect(agentState(base, 1000 + QUIET_MS)).toBe("waiting")
  })

  it("waits after a bell until the user answers", () => {
    const rang = { ...base, bellAt: 1500 }
    expect(agentState(rang, 1600)).toBe("waiting")
    expect(agentState({ ...rang, inputAt: 1700, lastOutputAt: 1800 }, 1900)).toBe("working")
    // A bell older than the last input doesn't count.
    expect(agentState({ ...rang, inputAt: 2000, lastOutputAt: 2000 }, 2100)).toBe("working")
  })

  it("tells a clean exit from a failure", () => {
    expect(agentState({ ...base, running: false, exitCode: 0 }, 0)).toBe("done")
    expect(agentState({ ...base, running: false, exitCode: 1 }, 0)).toBe("failed")
    expect(agentState({ ...base, running: false, exitCode: -1 }, 0)).toBe("failed")
    // Stopped by the user: not a failure.
    expect(agentState({ ...base, running: false, exitCode: 1, stopped: true }, 0)).toBe("stopped")
  })

  it("labels a session by its task, then its title, then its agent", () => {
    const kinds = [{ id: "opencode", name: "OpenCode", path: "/x" }]
    const fallback = (name: string) => `${name} session`
    expect(sessionLabel({ ...base, task: "\n  Fix the login page\nand tests" }, kinds, fallback)).toBe("Fix the login page")
    expect(sessionLabel({ ...base, title: "OC | Login" }, kinds, fallback)).toBe("OC | Login")
    expect(sessionLabel(base, kinds, fallback)).toBe("OpenCode session")
  })
})

describe("new worktree names", () => {
  const now = new Date(2026, 10, 8, 9, 5)

  it("slugs the English words of a task", () => {
    expect(slugify("Fix the login page's 500 error, please!", now)).toBe("fix-the-login-page-s")
    expect(slugify("Add OAuth2 to API v3", now)).toBe("add-oauth2-to-api-v3")
    expect(defaultBranch("Refactor graph lanes", now)).toBe("agent/refactor-graph-lanes")
  })

  it("falls back to a time stamp for tasks without English words", () => {
    expect(slugify("修一下登录页", now)).toBe("task-1108-0905")
    expect(slugify("", now)).toBe("task-1108-0905")
    expect(slugify("给 diff 加上 word wrap", now)).toBe("diff-word-wrap")
  })

  it("keeps slugs short", () => {
    expect(slugify("internationalization localization accessibility performance observability", now).length).toBeLessThanOrEqual(40)
  })

  it("puts the worktree next to the repository", () => {
    expect(worktreePath("/Users/me/Code/retrace", "agent/fix-login")).toBe("/Users/me/Code/retrace.worktrees/fix-login")
    expect(worktreePath("/srv/shop.git/", "x")).toBe("/srv/shop.worktrees/x")
  })
})

describe("terminal bytes", () => {
  it("pastes a message as one bracketed block without escape characters", () => {
    expect(pasted("第一行\r\nsecond\nthird")).toBe("\x1b[200~第一行\rsecond\rthird\x1b[201~")
    expect(pasted("end it\x1b[201~ early")).toBe("\x1b[200~end it[201~ early\x1b[201~")
  })

  it("tells the terminal's own replies from typing", () => {
    for (const reply of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[40;1R", "\x1b[0n", "\x1b]11;rgb:1919/1919/1919\x1b\\", "\x1b]10;rgb:ecec/ecec/ecec\x07", "\x1b[?2026;2$y", "\x1b[I", "\x1b[O", "\x1b[?0u", "\x1b[?1;2c\x1b[40;1R"]) {
      expect(isTerminalReport(reply), JSON.stringify(reply)).toBe(true)
    }
    for (const key of ["a", "\r", "\x1b", "\x1b[A", "\x1bOB", "\x1b[15~", "\x1b[<0;10;5M", "\x03", "你好"]) {
      expect(isTerminalReport(key), JSON.stringify(key)).toBe(false)
    }
  })

  it("round-trips bytes through base64", () => {
    const bytes = new TextEncoder().encode("hé 你好 \x1b[31m")
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
    const big = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(fromBase64(toBase64(big))).toEqual(big)
  })

  it("keeps only the unseen part of a chunk", () => {
    expect(newPart(0, 10, 0)).toEqual({ skip: 0 })
    expect(newPart(0, 10, 4)).toEqual({ skip: 4 })
    expect(newPart(0, 10, 10)).toBeNull()
    expect(newPart(12, 5, 10)).toBe("gap")
  })
})

it("offers a history picker only for stopped supported providers", () => {
  expect(canResume({ ...base, agent: "codex", running: false })).toBe(true)
  expect(canResume({ ...base, agent: "claude", running: false })).toBe(true)
  expect(canResume({ ...base, agent: "codex" })).toBe(false)
  expect(canResume({ ...base, running: false })).toBe(false)
  expect(agentState({ ...base, running: false, exitCode: 0, stopped: true }, 0)).toBe("stopped")
})
