// Retrace's ear inside an OpenCode it started. OpenCode loads this plugin only in those sessions
// (Retrace adds it through OPENCODE_CONFIG_CONTENT); it appends the few events Retrace needs to
// the file named by RETRACE_AGENT_EVENTS, one JSON object per line. Retrace reads that file to
// show the session's state (working, asking for a permission, failed) and to reopen the same
// conversation later. Nothing else leaves OpenCode: no messages, no tool input or output.

import { appendFileSync } from "node:fs"

// Read once and removed, so an OpenCode started by the agent itself doesn't write to this feed.
const feed = process.env.RETRACE_AGENT_EVENTS
delete process.env.RETRACE_AGENT_EVENTS

/** The event cut down to what Retrace uses, or null for the ones it doesn't. */
function slim(event) {
  const type = event?.type
  if (typeof type !== "string") return null
  const p = event.properties ?? {}
  const sessionID = p.sessionID ?? p.info?.id
  switch (type) {
    case "session.created":
    case "session.deleted":
      return { type, properties: { sessionID, info: { id: p.info?.id ?? sessionID, parentID: p.info?.parentID ?? null } } }
    case "session.status":
      return { type, properties: { sessionID, status: { type: p.status?.type } } }
    case "session.idle":
    case "tui.session.select":
      return { type, properties: { sessionID } }
    case "session.error":
      return { type, properties: { sessionID, error: { name: p.error?.name, data: { message: p.error?.data?.message } } } }
  }
  if (type.startsWith("permission.") || type.startsWith("question.")) {
    const questions = Array.isArray(p.questions) ? p.questions.map((q) => ({ question: q?.question })) : undefined
    return { type, properties: { id: p.id, requestID: p.requestID, sessionID, permission: p.permission, patterns: p.patterns, questions } }
  }
  return null
}

function write(line) {
  try {
    appendFileSync(feed, JSON.stringify(line) + "\n")
  } catch {
    // Retrace is gone or the file can't be written: the session works the same without it.
  }
}

// The only export: OpenCode calls every export of a plugin file as a plugin.
export const RetraceFeed = async () => {
  if (!feed) return {}
  write({ type: "retrace.ready" })
  return {
    event: async ({ event }) => {
      const line = slim(event)
      if (line) write(line)
    },
  }
}

// For Retrace's own tests.
RetraceFeed.slim = slim
