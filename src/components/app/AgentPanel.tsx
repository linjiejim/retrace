import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { GitBranch, History, MessageSquare, RotateCcw, SendHorizontal, Square, X } from "lucide-react"
import { onAgentChanged } from "@/lib/api"
import { agentState, canResume, isSaved, resumesDirectly, sessionLabel } from "@/lib/agent-state"
import { drafts } from "@/lib/drafts"
import { t } from "@/lib/i18n"
import { keepChats } from "@/lib/agent-chat"
import { isImeKey } from "@/lib/keys"
import { prefs, ui, useStore } from "@/lib/store"
import { attachTerminal, ensureTerminal, keepTerminals, sendMessage } from "@/lib/terminals"
import type { AgentKind, AgentSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAgentKinds, useAgentSessions, useNow } from "@/hooks/agents"
import { Button, IconButton } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import { StateView } from "@/components/ui/state"
import { notify } from "@/components/ui/toast"
import { AgentChat } from "./AgentChat"
import { AgentStateIcon, fallbackLabel, useSessionActions } from "./AgentSessionRow"

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Keeps one terminal per listed terminal session (made as soon as a session appears) and the list fresh. */
export function AgentTerminals() {
  const qc = useQueryClient()
  const sessions = useAgentSessions().data
  useEffect(() => {
    const ids = new Set((sessions ?? []).map((s) => s.id))
    // A session already a few seconds old that this page has no terminal for: the page was reloaded.
    sessions?.filter((s) => !isSaved(s) && !s.chat).forEach((s) => ensureTerminal(s.id, s.running && Date.now() - s.startedAt > 5000))
    keepTerminals(ids)
    keepChats(ids)
    const shown = ui.get().agentSession
    if (shown && !ids.has(shown) && sessions) ui.set({ agentSession: null })
  }, [sessions])
  useEffect(() => {
    const off = onAgentChanged(() => qc.invalidateQueries({ queryKey: ["agents"] }))
    return () => void off.then((f) => f())
  }, [qc])
  return null
}

function TerminalHost({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return attachTerminal(id, ref.current)
  }, [id])
  return <div ref={ref} className="h-full w-full" />
}

function MessageBox({ id, agent, disabled }: { id: string; agent: string; disabled: boolean }) {
  // Kept per session while unsent: closing the drawer or showing another session doesn't lose it.
  const [text, setText] = useState(() => drafts.get(id))
  const [sending, setSending] = useState(false)
  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      await sendMessage(id, body)
      setText("")
      drafts.clear(id)
    } catch (e) {
      notify.error(t("Couldn't send the message: {reason}", { reason: message(e) }))
    } finally {
      setSending(false)
    }
  }
  return (
    <form
      className="flex shrink-0 items-end gap-1.5 border-t px-2 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          drafts.set(id, e.target.value)
        }}
        onKeyDown={(e) => {
          // Enter while an input method is composing picks a candidate; it doesn't send.
          if (e.key === "Enter" && !e.shiftKey && !isImeKey(e.nativeEvent)) {
            e.preventDefault()
            void send()
          }
        }}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        disabled={disabled}
        aria-label={t("Message to {agent}", { agent })}
        placeholder={disabled ? t("The session has ended") : t("Message {agent} · ↩ to send, ⇧↩ for a new line", { agent })}
        className="min-h-0 resize-none py-1.5"
      />
      <IconButton label={t("Send")} type="submit" variant="secondary" disabled={disabled || !text.trim()} loading={sending}>
        <SendHorizontal />
      </IconButton>
    </form>
  )
}

/** What Resume does for this session's agent. */
function resumeHint(s: AgentSession, kinds: AgentKind[] | undefined): string {
  return resumesDirectly(s, kinds)
    ? t("Resume reopens this conversation in its worktree; the task isn't sent again.")
    : t("Resume opens the agent's history picker in this worktree. Choose the conversation to continue.")
}

/** Narrowest the drawer gets, and the room it always leaves on its left. */
const MIN_WIDTH = 420
const KEEP_LEFT = 240

/** Drag the drawer's left edge; the width is remembered. */
function startResize(e: React.PointerEvent, drawer: HTMLElement | null) {
  if (!drawer) return
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const right = drawer.getBoundingClientRect().right
  document.body.style.cursor = "col-resize"
  const move = (ev: PointerEvent) => {
    const max = Math.max(MIN_WIDTH, window.innerWidth - KEEP_LEFT)
    prefs.set({ agentWidth: Math.round(Math.min(max, Math.max(MIN_WIDTH, right - ev.clientX))) })
  }
  const up = () => {
    document.body.style.cursor = ""
    el.removeEventListener("pointermove", move)
    el.removeEventListener("pointerup", up)
  }
  el.addEventListener("pointermove", move)
  el.addEventListener("pointerup", up)
}

/**
 * The agent session floats over the right of the window instead of taking a column: open it
 * from a session row, close it with ✕, ⌘T, Esc or by clicking its row again (in a terminal, Esc
 * belongs to the agent). It doesn't
 * block the rest of the window, so the projects list can switch sessions while it is open. A
 * session is a conversation (an agent that speaks ACP) or the agent's own terminal UI.
 */
export function AgentDrawer() {
  const open = useStore(ui, (s) => s.agentOpen)
  const id = useStore(ui, (s) => s.agentSession)
  const showInput = useStore(prefs, (s) => s.agentInput)
  const width = useStore(prefs, (s) => s.agentWidth)
  const drawer = useRef<HTMLElement>(null)
  const sessions = useAgentSessions()
  const kinds = useAgentKinds().data
  const s = sessions.data?.find((x) => x.id === id) ?? null
  // Only a terminal's state depends on the time (quiet for a while = waiting); a conversation
  // reports its own (`live`), so it doesn't re-render the whole drawer every second.
  const now = useNow(open && !!s?.running && !s.live)
  if (!open) return null
  const label = s ? sessionLabel(s, kinds, fallbackLabel) : ""
  const agentName = s ? (kinds?.find((k) => k.id === s.agent)?.name ?? s.agent) : ""

  return (
    <aside
      ref={drawer}
      aria-label={t("Agent")}
      data-agent-drawer
      className="absolute inset-y-0 right-0 z-40 flex max-w-[calc(100%-240px)] animate-slide-in-right flex-col border-l bg-background shadow-overlay"
      style={{ width: width ?? "min(60vw, 960px)", minWidth: MIN_WIDTH }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Drag to resize")}
        onPointerDown={(e) => startResize(e, drawer.current)}
        onDoubleClick={() => prefs.set({ agentWidth: null })}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      <header data-tauri-drag-region className="flex h-[38px] shrink-0 items-center gap-1 border-b pl-3 pr-2">
        {s ? (
          <>
            <AgentStateIcon state={agentState(s, now)} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-small font-medium">{label}</span>
            {s.branch && (
              <span className="inline-flex max-w-[220px] shrink-0 items-center gap-1 truncate text-caption text-faint-foreground">
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{s.branch}</span>
              </span>
            )}
            <span className="shrink-0 pr-1 text-caption text-faint-foreground">{agentName}</span>
            <SessionButtons session={s} label={label} kinds={kinds} />
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">{t("Agent")}</span>
        )}
        {s && !s.chat && !isSaved(s) && (
          <IconButton label={showInput ? t("Hide the message box") : t("Show the message box")} size="icon-sm" onClick={() => prefs.set({ agentInput: !showInput })} className={cn(!showInput && "text-faint-foreground")}>
            <MessageSquare />
          </IconButton>
        )}
        <IconButton label={`${t("Close")}  Esc`} size="icon-sm" onClick={() => ui.set({ agentOpen: false })}>
          <X />
        </IconButton>
      </header>
      {s ? (
        <>
          {isSaved(s) ? (
            <div className="min-h-0 flex-1 px-2 pt-1.5">
              <SavedSession session={s} label={label} kinds={kinds} />
            </div>
          ) : s.chat ? (
            <AgentChat key={s.id} session={s} agentName={agentName} />
          ) : (
            <div className="min-h-0 flex-1 px-2 pt-1.5">
              <TerminalHost id={s.id} />
            </div>
          )}
          {!s.running && s.exitCode !== null && (
            <p className="shrink-0 border-t px-3 py-2 text-caption text-faint-foreground">
              {s.stopped
                ? t("You stopped {agent}.", { agent: agentName })
                : s.exitCode === 0
                  ? t("{agent} has finished.", { agent: agentName })
                  : t("{agent} stopped (exit code {code}).", { agent: agentName, code: s.exitCode ?? "?" })}
              {canResume(s) && <span className="ml-1">{resumeHint(s, kinds)}</span>}
            </p>
          )}
          {showInput && s.running && !s.chat && <MessageBox key={s.id} id={s.id} agent={agentName} disabled={!s.running} />}
        </>
      ) : (
        <StateView size="sm" kind="empty" title={t("No agent session open")} description={t("Start one with + on a project, or press ⌘N.")} />
      )}
    </aside>
  )
}

/** A session from before Retrace was restarted: its process is gone, its conversation isn't. */
function SavedSession({ session: s, label, kinds }: { session: AgentSession; label: string; kinds: AgentKind[] | undefined }) {
  const { resume, resuming, element } = useSessionActions(s, label)
  return (
    <>
      <StateView
        size="sm"
        kind="empty"
        icon={<History />}
        title={t("Session saved")}
        description={resumeHint(s, kinds)}
        action={
          <Button variant="primary" size="sm" loading={resuming} onClick={() => void resume()}>
            {resumesDirectly(s, kinds) ? t("Resume Session") : t("Resume Session…")}
          </Button>
        }
      />
      {element}
    </>
  )
}

function SessionButtons({ session: s, label, kinds }: { session: AgentSession; label: string; kinds: AgentKind[] | undefined }) {
  const { stop, resume, resuming, element } = useSessionActions(s, label)
  return (
    <>
      {canResume(s) && (
        <IconButton label={resumesDirectly(s, kinds) ? t("Resume Session") : t("Resume Session…")} size="icon-sm" loading={resuming} onClick={() => void resume()}>
          <RotateCcw />
        </IconButton>
      )}
      {s.running && (
        <IconButton label={t("Stop Agent")} size="icon-sm" onClick={stop}>
          <Square />
        </IconButton>
      )}
      {element}
    </>
  )
}
