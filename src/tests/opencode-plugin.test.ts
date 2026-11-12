// The plugin Retrace loads into the OpenCode sessions it starts (src-tauri/src/core/opencode_plugin.js):
// it runs inside OpenCode, so this is the only place it gets exercised without one.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const file = path.resolve(__dirname, "../../src-tauri/src/core/opencode_plugin.js")
const feed = path.join(os.tmpdir(), `retrace-plugin-test-${process.pid}.jsonl`)

type Feed = (() => Promise<{ event?: (input: { event: unknown }) => Promise<void> }>) & { slim: (event: unknown) => unknown }
let exported: Record<string, unknown>
let plugin: Feed

beforeAll(async () => {
  process.env.RETRACE_AGENT_EVENTS = feed
  exported = (await import(/* @vite-ignore */ file)) as Record<string, unknown>
  plugin = exported.RetraceFeed as Feed
})
afterAll(() => fs.rmSync(feed, { force: true }))

const lines = () =>
  fs
    .readFileSync(feed, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))

describe("the OpenCode plugin", () => {
  it("exports the plugin and nothing else: OpenCode calls every export as a plugin", () => {
    expect(Object.keys(exported)).toEqual(["RetraceFeed"])
  })

  it("takes the feed's path for itself, so an OpenCode the agent starts doesn't write to it", () => {
    expect(process.env.RETRACE_AGENT_EVENTS).toBeUndefined()
  })

  it("says it is loaded, then passes on the events Retrace uses and nothing else", async () => {
    const hooks = await plugin()
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: { text: "the user's code" } } } })
    await hooks.event!({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } })
    await hooks.event!({
      event: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, tool: { callID: "c" } } },
    })
    expect(lines()).toEqual([
      { type: "retrace.ready" },
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] } },
    ])
  })

  it("keeps ids, states and short reasons, not content", () => {
    const slim = plugin.slim
    expect(slim({ type: "session.created", properties: { sessionID: "ses_1", info: { id: "ses_1", title: "Secret plan", directory: "/x" } } })).toEqual({
      type: "session.created",
      properties: { sessionID: "ses_1", info: { id: "ses_1", parentID: null } },
    })
    expect(slim({ type: "session.created", properties: { info: { id: "ses_2", parentID: "ses_1" } } })).toEqual({
      type: "session.created",
      properties: { sessionID: "ses_2", info: { id: "ses_2", parentID: "ses_1" } },
    })
    expect(slim({ type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "insufficient balance", responseHeaders: { a: "b" } } } } })).toEqual({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "insufficient balance" } } },
    })
    expect(slim({ type: "question.asked", properties: { id: "que_1", sessionID: "ses_1", questions: [{ question: "Which one?", options: [{ label: "A" }] }] } })).toEqual({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_1", questions: [{ question: "Which one?" }] },
    })
    expect(slim({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "per_1", reply: "once" } })).toEqual({
      type: "permission.replied",
      properties: { requestID: "per_1", sessionID: "ses_1" },
    })
    for (const ignored of ["session.updated", "session.diff", "message.updated", "file.edited", "plugin.added"]) expect(slim({ type: ignored, properties: {} })).toBeNull()
    expect(slim(null)).toBeNull()
    expect(slim({})).toBeNull()
  })
})
