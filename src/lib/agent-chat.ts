// A conversation with an agent, as the Agent drawer shows it. The backend keeps the records (see
// `chat.rs`); this file fetches what changed, and cuts the records into turns: what you asked,
// the steps the agent took (folded away by default), its answer, and the files it changed.

import { useEffect, useSyncExternalStore } from "react"
import { api, inTauri, onAgentTranscript } from "./api"
import type { AgentDiffStat, AgentItem, AgentOption, AgentSession, AgentTranscript } from "./types"

type Of<K extends AgentItem["kind"]> = Extract<AgentItem, { kind: K }>
export type ToolItem = Of<"tool">
export type AskItem = Of<"ask">
export type SetupItem = Of<"setup">
/** What a turn's folded steps list holds: tool calls, thinking, the plan, answered permissions, and things said along the way. */
export type Step = Of<"tool"> | Of<"thought"> | Of<"plan"> | Of<"ask"> | Of<"message">

export interface Turn {
  /** The id of its first record. */
  key: number
  /** Your message; null for what the agent did before any (a reloaded conversation can start mid-way). */
  user: string | null
  steps: Step[]
  /** The agent's answer: what it said after its last step. */
  answer: string
  errors: string[]
  /** How it ended (`end_turn`, `cancelled`, `error`, …); null while it runs. */
  end: string | null
  /** Files edited in this turn, with the line counts of all its edits added up. */
  changes: AgentDiffStat[]
}

// ---------- pure ----------

/** `have` with the changed records replaced or added, in id order. */
export function mergeItems(have: AgentItem[], changed: AgentItem[]): AgentItem[] {
  if (!changed.length) return have
  const byId = new Map(have.map((i) => [i.id, i]))
  for (const i of changed) byId.set(i.id, i)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

function closeTurn(turn: Turn, said: Of<"message">[]) {
  // What the agent said before going on to another step is part of the process, not the answer.
  const lastStep = turn.steps.reduce((at, s) => (s.kind === "message" ? at : Math.max(at, s.id)), 0)
  for (const m of said) if (m.id < lastStep) turn.steps.push(m)
  turn.steps.sort((a, b) => a.id - b.id)
  turn.answer = said
    .filter((m) => m.id > lastStep)
    .map((m) => m.text)
    .join("\n\n")
  const changes = new Map<string, AgentDiffStat>()
  for (const s of turn.steps) {
    if (s.kind !== "tool" || s.status !== "completed") continue
    for (const d of s.diffs) {
      const sum = changes.get(d.path) ?? { path: d.path, added: 0, removed: 0 }
      changes.set(d.path, { path: d.path, added: sum.added + d.added, removed: sum.removed + d.removed })
    }
  }
  turn.changes = [...changes.values()]
}

/** The setup command's record (if any) and the conversation cut into turns: each of your messages starts one. */
export function splitTurns(items: AgentItem[]): { setup: SetupItem | null; turns: Turn[] } {
  let setup: SetupItem | null = null
  const turns: Turn[] = []
  /** What the agent said in each turn, by turn. */
  const said: Of<"message">[][] = []
  const open = (key: number, user: string | null): Turn => {
    const turn: Turn = { key, user, steps: [], answer: "", errors: [], end: null, changes: [] }
    turns.push(turn)
    said.push([])
    return turn
  }
  for (const item of items) {
    if (item.kind === "setup") {
      setup = item
      continue
    }
    if (item.kind === "user") {
      open(item.id, item.text)
      continue
    }
    // Something after a finished turn with no message of yours in between: its own turn.
    const last = turns[turns.length - 1]
    const turn = last && last.end === null ? last : open(item.id, null)
    if (item.kind === "message") said[said.length - 1].push(item)
    else if (item.kind === "error") turn.errors.push(item.text)
    else if (item.kind === "end") turn.end = item.reason
    else turn.steps.push(item)
  }
  turns.forEach((turn, i) => closeTurn(turn, said[i]))
  return { setup, turns }
}

const sameList = <T>(a: T[], b: T[], same: (x: T, y: T) => boolean) => a.length === b.length && a.every((x, i) => same(x, b[i]))

/**
 * Two cuts of a turn that show the same thing. `splitTurns` makes new turns every time; the records
 * in them are replaced only when they change (`mergeItems`), so steps compare as the same objects.
 */
export function sameTurn(a: Turn, b: Turn): boolean {
  return (
    a === b ||
    (a.key === b.key &&
      a.user === b.user &&
      a.answer === b.answer &&
      a.end === b.end &&
      sameList(a.steps, b.steps, (x, y) => x === y) &&
      sameList(a.errors, b.errors, (x, y) => x === y) &&
      sameList(a.changes, b.changes, (x, y) => x.path === y.path && x.added === y.added && x.removed === y.removed))
  )
}

export interface StepCounts {
  read: number
  edit: number
  run: number
  search: number
  other: number
}

/** How many of each kind of step a turn took (files read or edited count once each). */
export function countSteps(turn: Turn): StepCounts {
  const read = new Set<string>()
  const edited = new Set<string>()
  const counts: StepCounts = { read: 0, edit: 0, run: 0, search: 0, other: 0 }
  for (const s of turn.steps) {
    if (s.kind !== "tool") continue
    const file = s.paths[0] ?? s.title
    if (s.tool === "read") read.add(file)
    else if (s.tool === "edit" || s.tool === "delete" || s.tool === "move") edited.add(file)
    else if (s.tool === "execute") counts.run++
    else if (s.tool === "search") counts.search++
    else counts.other++
  }
  counts.read = read.size
  counts.edit = edited.size
  return counts
}

/** The step a running turn is on: the tool call still in progress, else the last thing it did. */
export function currentStep(turn: Turn): Step | null {
  const running = [...turn.steps].reverse().find((s) => s.kind === "tool" && (s.status === "pending" || s.status === "in_progress"))
  return running ?? turn.steps[turn.steps.length - 1] ?? null
}

/** Permission requests still waiting for an answer, oldest first. */
export function waitingAsks(items: AgentItem[]): AskItem[] {
  return items.filter((i): i is AskItem => i.kind === "ask" && i.answer === null)
}

/** `12345` → `12.3k`. */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** The choices to remember for the next session: everything but the mode (a read-only session shouldn't make the next one read-only). */
export function rememberedOptions(options: AgentOption[]): Record<string, string> {
  return Object.fromEntries(options.filter((o) => o.category !== "mode").map((o) => [o.id, o.value]))
}

// ---------- the store ----------

export interface ChatState {
  rev: number
  items: AgentItem[]
  options: AgentOption[]
  usage: AgentTranscript["usage"]
  /** The first fetch is back. */
  loaded: boolean
  /** The conversation can't be read (the session is gone). */
  error: string | null
}

interface Entry {
  state: ChatState
  listeners: Set<() => void>
  fetching: boolean
  /** Something changed while a fetch was out: fetch again when it is back. */
  again: boolean
}

const EMPTY: ChatState = { rev: 0, items: [], options: [], usage: null, loaded: false, error: null }
const chats = new Map<string, Entry>()
/** The browser dev bridge has no events: poll the shown conversation this often. */
const POLL_MS = 250
/** Inside the app events say when to fetch; this slow poll only covers a missed one. */
const SAFETY_MS = 2000
let listening: Promise<() => void> | null = null

function entry(id: string): Entry {
  let e = chats.get(id)
  if (!e) chats.set(id, (e = { state: EMPTY, listeners: new Set(), fetching: false, again: false }))
  return e
}

/** Fetch what changed since the last fetch; calls made meanwhile collapse into one more fetch. */
export async function pullChat(id: string) {
  const e = entry(id)
  if (e.fetching) return void (e.again = true)
  e.fetching = true
  try {
    const t = await api.agentTranscript(id, e.state.rev)
    if (chats.get(id) !== e) return
    // Also when nothing changed but the last fetch had failed: the error is over.
    if (t.rev !== e.state.rev || !e.state.loaded || e.state.error) {
      e.state = { rev: t.rev, items: mergeItems(e.state.items, t.items), options: t.options, usage: t.usage, loaded: true, error: null }
      e.listeners.forEach((l) => l())
    }
  } catch (err) {
    if (chats.get(id) !== e) return
    e.state = { ...e.state, loaded: true, error: err instanceof Error ? err.message : String(err) }
    e.listeners.forEach((l) => l())
  } finally {
    e.fetching = false
    if (e.again) {
      e.again = false
      void pullChat(id)
    }
  }
}

/** Drop the conversations of sessions no longer listed. */
export function keepChats(ids: Set<string>) {
  for (const id of chats.keys()) if (!ids.has(id)) chats.delete(id)
}

/** The conversation of a session, kept current while this is mounted. */
export function useChat(session: Pick<AgentSession, "id" | "running">): ChatState {
  const { id, running } = session
  const e = entry(id)
  const state = useSyncExternalStore(
    (l) => {
      e.listeners.add(l)
      return () => e.listeners.delete(l)
    },
    () => e.state,
  )
  useEffect(() => {
    void pullChat(id)
    if (inTauri) listening ??= onAgentTranscript((changed) => chats.has(changed) && void pullChat(changed))
    if (!running) return
    const poll = setInterval(() => void pullChat(id), inTauri ? SAFETY_MS : POLL_MS)
    return () => clearInterval(poll)
    // `running` going false fetches once more: the last records arrive with the exit.
  }, [id, running])
  return state
}
