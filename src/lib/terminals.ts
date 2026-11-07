// One xterm per agent session, alive for as long as the session is listed. A terminal starts in a
// parking spot off screen, so it can answer the agent's terminal queries (Codex waits for them)
// before anyone opens the view; the Agent view borrows its element while it shows that session.

import { Terminal, type ITheme } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import "@xterm/xterm/css/xterm.css"
import { api, inTauri, onAgentOutput } from "./api"
import { fromBase64, isTerminalReport, newPart, pasted, toBase64 } from "./agent-state"

/** Size a terminal starts at (and the agent's first screen), before the view fits it. */
export const START_COLS = 120
export const START_ROWS = 36
/** The browser dev bridge has no events: poll this often. */
const POLL_MS = 80

interface Handle {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  /** Stream offset written so far. */
  next: number
  /** Catching up from the backend's scrollback; live chunks wait until it's done. */
  syncing: boolean
  pending: { offset: number; bytes: Uint8Array }[]
  shown: boolean
  stop: () => void
}

const handles = new Map<string, Handle>()
let lot: HTMLDivElement | null = null
let unlisten: Promise<() => void> | null = null

function parkingLot(): HTMLDivElement {
  if (lot) return lot
  lot = document.createElement("div")
  lot.setAttribute("aria-hidden", "true")
  Object.assign(lot.style, { position: "absolute", left: "-20000px", top: "0", width: "1200px", height: "800px", overflow: "hidden", visibility: "hidden", pointerEvents: "none" })
  document.body.appendChild(lot)
  return lot
}

/** A theme token as a concrete colour xterm can parse (tokens may be `var()` or `color-mix()`). */
function tokenColor(name: string, alpha?: number): string {
  const probe = document.createElement("span")
  probe.style.color = `var(${name})`
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  const ctx = document.createElement("canvas").getContext("2d")
  if (!ctx) return color
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  const out = alpha ?? a / 255
  return `rgba(${r}, ${g}, ${b}, ${out})`
}

function theme(): ITheme {
  return {
    background: tokenColor("--background"),
    foreground: tokenColor("--foreground"),
    cursor: tokenColor("--foreground"),
    cursorAccent: tokenColor("--background"),
    selectionBackground: tokenColor("--primary", 0.28),
    selectionInactiveBackground: tokenColor("--primary", 0.16),
  }
}

/** Light / dark switches restyle every terminal. */
let watchingTheme = false
function watchTheme() {
  if (watchingTheme) return
  watchingTheme = true
  new MutationObserver(() => {
    const t = theme()
    for (const h of handles.values()) h.term.options.theme = t
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
}

const encoder = new TextEncoder()

/** `typed`: from the user, so it answers a bell (terminal replies to queries are not). */
function send(id: string, bytes: Uint8Array, typed: boolean) {
  api.agentWrite(id, toBase64(bytes), typed).catch(() => {})
}

function write(h: Handle, offset: number, bytes: Uint8Array): "ok" | "gap" {
  const part = newPart(offset, bytes.length, h.next)
  if (part === "gap") return "gap"
  if (part) {
    h.term.write(part.skip ? bytes.subarray(part.skip) : bytes)
    h.next = offset + bytes.length
  }
  return "ok"
}

/** Read what the backend has from where this terminal is, then let live chunks through. */
async function catchUp(id: string, h: Handle) {
  h.syncing = true
  try {
    for (;;) {
      const chunk = await api.agentRead(id, h.next)
      if (handles.get(id) !== h) return
      const bytes = fromBase64(chunk.data)
      // Older bytes were trimmed from the scrollback: start clean from what is left.
      if (chunk.start > h.next) {
        h.term.reset()
        h.next = chunk.start
      }
      write(h, chunk.start, bytes)
      if (chunk.next <= h.next) break
    }
  } catch {
    // The session is gone; the list will drop this terminal.
  } finally {
    h.syncing = false
  }
  const queued = h.pending.splice(0)
  for (const c of queued) if (write(h, c.offset, c.bytes) === "gap") return void catchUp(id, h)
}

function listen() {
  unlisten ??= onAgentOutput((e) => {
    const h = handles.get(e.session)
    if (!h) return
    const bytes = fromBase64(e.data)
    if (h.syncing) return void h.pending.push({ offset: e.offset, bytes })
    if (write(h, e.offset, bytes) === "gap") void catchUp(e.session, h)
  })
}

/** The terminal for a session, made on first sight. */
export function ensureTerminal(id: string): Handle {
  const existing = handles.get(id)
  if (existing) return existing
  watchTheme()
  const term = new Terminal({
    cols: START_COLS,
    rows: START_ROWS,
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 5000,
    theme: theme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = "11"
  // ⌘ shortcuts belong to the app menu (copy and paste still work through the browser's own events).
  term.attachCustomKeyEventHandler((e) => !e.metaKey)
  const host = document.createElement("div")
  host.className = "h-full w-full"
  host.dataset.agentTerminal = id
  parkingLot().appendChild(host)
  term.open(host)

  const subs = [
    term.onData((d) => send(id, encoder.encode(d), !isTerminalReport(d))),
    term.onBinary((d) => send(id, Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff), true)),
    term.onResize(({ cols, rows }) => void api.agentResize(id, cols, rows).catch(() => {})),
  ]
  let poll: ReturnType<typeof setInterval> | null = null
  const h: Handle = {
    term,
    fit,
    host,
    next: 0,
    syncing: false,
    pending: [],
    shown: false,
    stop: () => {
      subs.forEach((s) => s.dispose())
      if (poll) clearInterval(poll)
    },
  }
  handles.set(id, h)
  if (inTauri) {
    listen()
    void catchUp(id, h)
  } else {
    void catchUp(id, h)
    poll = setInterval(() => !h.syncing && void catchUp(id, h), POLL_MS)
  }
  return h
}

/** Drop the terminals of sessions no longer listed. */
export function keepTerminals(ids: Set<string>) {
  for (const [id, h] of handles) {
    if (ids.has(id)) continue
    h.stop()
    h.term.dispose()
    h.host.remove()
    handles.delete(id)
  }
}

/** Show a session's terminal in `container`, sized to it; returns a function that parks it again. */
export function attachTerminal(id: string, container: HTMLElement): () => void {
  const h = ensureTerminal(id)
  container.appendChild(h.host)
  h.shown = true
  const refit = () => {
    if (!h.shown || container.clientWidth === 0 || container.clientHeight === 0) return
    try {
      h.fit.fit()
    } catch {
      // Not measurable yet; the next resize fits it.
    }
  }
  const frame = requestAnimationFrame(refit)
  const observer = new ResizeObserver(() => refit())
  observer.observe(container)
  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    h.shown = false
    // Keep its size: the agent shouldn't redraw for the parking spot.
    parkingLot().appendChild(h.host)
  }
}

export function focusTerminal(id: string) {
  handles.get(id)?.term.focus()
}

/** A message from the box under the terminal: pasted as one block, then Enter. */
export async function sendMessage(id: string, text: string) {
  await api.agentWrite(id, toBase64(encoder.encode(pasted(text))), true)
  // Agents read the paste first; Enter in the same write can arrive as part of it.
  await new Promise((r) => setTimeout(r, 60))
  await api.agentWrite(id, toBase64(encoder.encode("\r")), true)
}
