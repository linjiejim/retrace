// What an agent session is doing, judged from its terminal: output means working, silence or a
// bell means it waits for you. Plus the small text helpers the new-session dialog and the
// message box need. No DOM here, so it is all unit-tested.

import type { AgentKind, AgentSession } from "./types"

export type AgentState = "working" | "waiting" | "done" | "stopped" | "failed"

/** This long without output and the agent is taken to be waiting (agents animate while they work). */
export const QUIET_MS = 4000

export function agentState(s: AgentSession, now: number): AgentState {
  if (!s.running) return s.stopped ? "stopped" : s.exitCode === 0 ? "done" : "failed"
  const rang = s.bellAt !== null && (s.inputAt === null || s.bellAt > s.inputAt)
  if (rang) return "waiting"
  return now - s.lastOutputAt < QUIET_MS ? "working" : "waiting"
}

/** English names; show them through t(). */
export const STATE_LABEL: Record<AgentState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Finished",
  stopped: "Stopped",
  failed: "Stopped with an error",
}

/** `text` cut to `max` characters with an ellipsis, for titles. */
export function short(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** The first line of the task, else the agent's own title, else "<Agent> session". */
export function sessionLabel(s: AgentSession, kinds: AgentKind[] | undefined, fallback: (agent: string) => string): string {
  const line = s.task.split("\n").find((l) => l.trim())?.trim()
  if (line) return line
  if (s.title) return s.title
  return fallback(kinds?.find((k) => k.id === s.agent)?.name ?? s.agent)
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Up to five English words or numbers from the task, kebab-cased; `task-MMDD-HHmm` when there are none. */
export function slugify(task: string, now: Date): string {
  const words = task.toLowerCase().match(/[a-z0-9]+/g) ?? []
  let slug = ""
  for (const w of words.slice(0, 5)) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > 40) break
    slug = next
  }
  return slug || `task-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

export const BRANCH_PREFIX = "agent/"

export function defaultBranch(task: string, now: Date): string {
  return BRANCH_PREFIX + slugify(task, now)
}

/** Where the backend puts a new worktree: `<parent>/<repo>.worktrees/<last part of the branch>`. */
export function worktreePath(projectPath: string, branch: string): string {
  const cut = projectPath.replace(/\/+$/, "")
  const at = cut.lastIndexOf("/")
  const parent = cut.slice(0, at)
  const name = cut.slice(at + 1).replace(/\.git$/, "")
  const leaf = branch.split("/").pop() || branch
  return `${parent}/${name}.worktrees/${leaf}`
}

/**
 * A message as the terminal would paste it: bracketed, so the agent takes newlines as text, not
 * as "send". ESC is dropped so the text can't end the paste early. Enter goes separately.
 */
export function pasted(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\x1b/g, "").replace(/\n/g, "\r")
  return `\x1b[200~${clean}\x1b[201~`
}

/** Replies the terminal sends by itself (device attributes, cursor position, colours, focus): not the user typing. */
const REPORT = /^(?:\x1b\[[?>]?[\d;]*[cnR]|\x1b\[\?[\d;]*\$y|\x1b\[\?[\d;]*u|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[IO])+$/

export function isTerminalReport(data: string): boolean {
  return REPORT.test(data)
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function fromBase64(data: string): Uint8Array {
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The part of a chunk at `offset` that is new after `next` bytes were written: `null` = all old, `"gap"` = bytes missing. */
export function newPart(offset: number, length: number, next: number): { skip: number } | null | "gap" {
  if (offset > next) return "gap"
  if (offset + length <= next) return null
  return { skip: next - offset }
}

/** Providers whose CLI exposes an interactive history picker. */
export function canResume(s: AgentSession): boolean {
  return !s.running && (s.agent === "codex" || s.agent === "claude")
}
