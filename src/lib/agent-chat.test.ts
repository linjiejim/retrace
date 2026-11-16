import { describe, expect, it } from "vitest"
import { compactNumber, countSteps, currentStep, mergeItems, rememberedOptions, sameTurn, splitTurns, waitingAsks } from "./agent-chat"
import type { AgentItem, AgentItemBody } from "./types"

/** Records numbered in order, like the backend's. */
function items(...bodies: AgentItemBody[]): AgentItem[] {
  return bodies.map((b, i) => ({ id: i + 1, rev: i + 1, ...b }) as AgentItem)
}

const tool = (tool: string, more: Partial<Extract<AgentItemBody, { kind: "tool" }>> = {}): AgentItemBody => ({ kind: "tool", tool, title: tool, status: "completed", paths: [], command: null, output: null, diffs: [], ...more })
const ask = (answer: string | null): AgentItemBody => ({ kind: "ask", request: 7, title: "rm -rf build", tool: "execute", command: "rm -rf build", paths: [], options: [{ id: "once", name: "Allow once", kind: "allow_once" }], answer })

describe("a conversation cut into turns", () => {
  it("starts a turn at each of your messages and keeps the setup command apart", () => {
    const { setup, turns } = splitTurns(
      items(
        { kind: "setup", command: "pnpm install", output: "done\n", code: 0 },
        { kind: "user", text: "add divide" },
        { kind: "thought", text: "Let me look." },
        tool("read", { paths: ["cart.js"] }),
        tool("edit", { paths: ["cart.js"], diffs: [{ path: "cart.js", added: 2, removed: 0 }] }),
        { kind: "message", text: "Added `divide`." },
        { kind: "end", reason: "end_turn" },
        { kind: "user", text: "and modulo" },
        tool("edit", { paths: ["cart.js"], status: "in_progress" }),
      ),
    )
    expect(setup?.command).toBe("pnpm install")
    expect(turns.map((t) => [t.user, t.end, t.answer])).toEqual([
      ["add divide", "end_turn", "Added `divide`."],
      ["and modulo", null, ""],
    ])
    expect(turns[0].steps.map((s) => s.kind)).toEqual(["thought", "tool", "tool"])
    expect(turns[0].key).toBe(2)
  })

  it("takes what the agent says after its last step as the answer, the rest as part of the process", () => {
    const { turns } = splitTurns(
      items({ kind: "user", text: "fix it" }, { kind: "message", text: "I'll check the tests first." }, tool("execute", { command: "pnpm test" }), { kind: "message", text: "They pass." }, { kind: "message", text: "Nothing to fix." }, { kind: "end", reason: "end_turn" }),
    )
    expect(turns[0].answer).toBe("They pass.\n\nNothing to fix.")
    expect(turns[0].steps.map((s) => (s.kind === "message" ? s.text : s.kind))).toEqual(["I'll check the tests first.", "tool"])
  })

  it("adds up a turn's edits per file, counting only the ones that happened", () => {
    const { turns } = splitTurns(
      items(
        { kind: "user", text: "go" },
        tool("edit", { diffs: [{ path: "a.js", added: 2, removed: 1 }] }),
        tool("edit", { diffs: [{ path: "a.js", added: 1, removed: 0 }, { path: "b.js", added: 0, removed: 4 }] }),
        tool("edit", { status: "failed", diffs: [{ path: "c.js", added: 9, removed: 9 }] }),
      ),
    )
    expect(turns[0].changes).toEqual([
      { path: "a.js", added: 3, removed: 1 },
      { path: "b.js", added: 0, removed: 4 },
    ])
  })

  it("keeps a failed turn's reason with it, and what comes after a finished turn apart", () => {
    const { turns } = splitTurns(items({ kind: "user", text: "hi" }, { kind: "error", text: "insufficient balance (1008)" }, { kind: "end", reason: "error" }, { kind: "error", text: "fatal: the model fell over" }))
    expect(turns.map((t) => [t.user, t.errors, t.end])).toEqual([
      ["hi", ["insufficient balance (1008)"], "error"],
      [null, ["fatal: the model fell over"], null],
    ])
  })

  it("reads a reloaded conversation, which has no end marks", () => {
    const { turns } = splitTurns(items({ kind: "user", text: "earlier question" }, { kind: "message", text: "earlier answer" }, { kind: "user", text: "next" }, { kind: "message", text: "sure" }))
    expect(turns.map((t) => [t.user, t.answer])).toEqual([
      ["earlier question", "earlier answer"],
      ["next", "sure"],
    ])
  })
})

describe("the folded steps line", () => {
  const turn = (...bodies: AgentItemBody[]) => splitTurns(items({ kind: "user", text: "go" }, ...bodies)).turns[0]

  it("counts files once however often they were read or edited", () => {
    const counts = countSteps(turn(tool("read", { paths: ["a.js"] }), tool("read", { paths: ["a.js"] }), tool("read", { paths: ["b.js"] }), tool("edit", { paths: ["a.js"] }), tool("execute"), tool("execute"), tool("search"), tool("fetch"), { kind: "thought", text: "hm" }))
    expect(counts).toEqual({ read: 2, edit: 1, run: 2, search: 1, other: 1 })
  })

  it("shows the step still in progress, else the last one", () => {
    const running = currentStep(turn(tool("read", { title: "a.js", status: "in_progress" }), { kind: "thought", text: "hm" }))
    expect(running?.kind === "tool" && running.title).toBe("a.js")
    expect(currentStep(turn(tool("read"), { kind: "thought", text: "hm" }))?.kind).toBe("thought")
    expect(currentStep(turn())).toBeNull()
  })
})

describe("syncing a conversation", () => {
  it("replaces changed records and adds new ones, in order", () => {
    const have = items({ kind: "user", text: "go" }, { kind: "message", text: "Do" })
    const merged = mergeItems(have, [
      { id: 3, rev: 5, kind: "end", reason: "end_turn" },
      { id: 2, rev: 4, kind: "message", text: "Done." },
    ])
    expect(merged.map((i) => [i.id, i.kind === "message" ? i.text : i.kind])).toEqual([
      [1, "user"],
      [2, "Done."],
      [3, "end"],
    ])
    // Nothing new: the same list, so nothing re-renders.
    expect(mergeItems(have, [])).toBe(have)
  })

  it("knows which turns a new record left as they were, though every turn is cut anew", () => {
    const have = items(
      { kind: "user", text: "add divide" },
      tool("edit", { paths: ["cart.js"], diffs: [{ path: "cart.js", added: 2, removed: 0 }] }),
      { kind: "message", text: "Added `divide`." },
      { kind: "end", reason: "end_turn" },
      { kind: "user", text: "and modulo" },
      tool("read", { paths: ["cart.js"], status: "in_progress" }),
    )
    const before = splitTurns(have).turns
    // The read finishes and the agent starts answering.
    const after = splitTurns(mergeItems(have, [{ id: 6, rev: 7, ...tool("read", { paths: ["cart.js"] }) } as AgentItem, { id: 7, rev: 8, kind: "message", text: "Reading" }])).turns
    expect(after[0]).not.toBe(before[0])
    expect(sameTurn(before[0], after[0])).toBe(true)
    expect(sameTurn(before[1], after[1])).toBe(false)
    // More of the answer streams in: only the text differs.
    const later = splitTurns(mergeItems(have, [{ id: 6, rev: 7, ...tool("read", { paths: ["cart.js"] }) } as AgentItem, { id: 7, rev: 9, kind: "message", text: "Reading it all" }])).turns
    expect(sameTurn(after[1], later[1])).toBe(false)
  })

  it("finds the permissions still waiting", () => {
    expect(waitingAsks(items(ask("once"), ask(null), ask("cancelled"))).map((a) => a.id)).toEqual([2])
  })

  it("remembers the model and effort for next time, not the mode", () => {
    const option = (id: string, category: string | null, value: string) => ({ id, name: id, category, value, choices: [] })
    expect(rememberedOptions([option("model", "model", "a/x"), option("mode", "mode", "plan"), option("effort", "thought_level", "high")])).toEqual({ model: "a/x", effort: "high" })
  })

  it("shortens token counts", () => {
    expect([999, 1200, 21661, 200000, 1_500_000].map(compactNumber)).toEqual(["999", "1.2k", "21.7k", "200k", "1.5M"])
  })
})
