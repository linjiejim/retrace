// A conversation with an agent that speaks ACP (OpenCode), drawn by Retrace: what you asked, what
// it answered, what it changed. The steps in between fold into one line; a permission it needs
// is a card above the message box. The agent itself is the program installed on this machine.

import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, FilePen, FileText, Globe, ListChecks, Search, Square, SquareTerminal, Wrench, X } from "lucide-react"
import { api } from "@/lib/api"
import { compactNumber, countSteps, currentStep, rememberedOptions, sameTurn, splitTurns, useChat, waitingAsks, pullChat, type AskItem, type SetupItem, type Step, type StepCounts, type ToolItem, type Turn } from "@/lib/agent-chat"
import { openSessionFile } from "@/lib/commands"
import { drafts } from "@/lib/drafts"
import { t, tp } from "@/lib/i18n"
import { isImeKey } from "@/lib/keys"
import { prefs } from "@/lib/store"
import type { AgentAskOption, AgentOption, AgentSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button, IconButton } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { StateView } from "@/components/ui/state"
import { notify } from "@/components/ui/toast"

const Markdown = lazy(() => import("./Markdown"))

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A filter box appears over a list longer than this. */
const FILTER_FROM = 12

export function AgentChat({ session: s, agentName }: { session: AgentSession; agentName: string }) {
  const chat = useChat(s)
  const { setup, turns } = useMemo(() => splitTurns(chat.items), [chat.items])
  const asks = useMemo(() => waitingAsks(chat.items), [chat.items])
  const busy = s.running && (s.live?.state === "busy" || s.live?.state === "asking")

  // A message sent, a turn ended, a permission asked or answered: the session's state has changed
  // with it, so the list (and this view's buttons) shouldn't wait for its next poll.
  const qc = useQueryClient()
  const marks = useMemo(() => chat.items.filter((i) => i.kind === "user" || i.kind === "end" || i.kind === "ask" || i.kind === "error").map((i) => i.rev).join(), [chat.items])
  useEffect(() => void qc.invalidateQueries({ queryKey: ["agents"] }), [marks, qc])

  // Follow new output while the view is at the bottom; leave it alone once the user scrolls up.
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [chat.rev, asks.length, busy])

  const send = async (text: string) => {
    pinned.current = true
    await api.agentPrompt(s.id, text)
    void pullChat(s.id)
  }

  if (chat.error && !chat.items.length) return <StateView size="sm" kind="error" title={t("Couldn't load the conversation")} description={chat.error} onRetry={() => void pullChat(s.id)} />

  const nothingYet = chat.loaded && !setup && !turns.length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="selectable min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 py-4">
          {setup && <SetupLine setup={setup} />}
          {turns.map((turn, i) => {
            const last = i === turns.length - 1
            return (
              <TurnView
                key={turn.key}
                turn={turn}
                // A reloaded conversation has no end marks: only the last turn can still be running.
                running={last && busy && turn.end === null}
                session={s}
                onRetry={last && s.running && !busy && turn.user && turn.errors.length ? () => send(turn.user!).catch((e) => notify.error(t("Couldn't send the message: {reason}", { reason: message(e) }))) : undefined}
              />
            )
          })}
          {!turns.length && busy && setup?.code !== null && (
            <p className="flex items-center gap-2 text-small text-muted-foreground">
              <Spinner className="size-3.5" />
              {s.nativeId ? t("Loading the conversation…") : t("Starting {agent}…", { agent: agentName })}
            </p>
          )}
          {nothingYet && !busy && s.running && <p className="py-8 text-center text-small text-faint-foreground">{t("Tell {agent} what to do in this worktree.", { agent: agentName })}</p>}
        </div>
      </div>
      {s.running && asks.map((ask) => <AskCard key={ask.id} ask={ask} session={s} agentName={agentName} />)}
      {s.running && <Composer key={s.id} session={s} agentName={agentName} busy={busy} ready={chat.loaded && !!s.nativeId} options={chat.options} usage={chat.usage} onSend={send} />}
    </div>
  )
}

// ---------- a turn ----------

interface TurnProps {
  turn: Turn
  running: boolean
  session: Pick<AgentSession, "project" | "tree">
  onRetry?: () => void
}

function TurnContent({ turn, running, session, onRetry }: TurnProps) {
  // The Markdown is the costly part: rendered again only when the answer itself changes.
  const answer = useMemo(
    () =>
      turn.answer ? (
        <Suspense fallback={<p className="whitespace-pre-wrap text-body">{turn.answer}</p>}>
          <Markdown text={turn.answer} path="" projectId={session.project} target={{ kind: "worktree", tree: session.tree }} compact />
        </Suspense>
      ) : null,
    [turn.answer, session.project, session.tree],
  )
  return (
    <section className="flex flex-col gap-2.5">
      {turn.user !== null && <p className="self-end whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-body max-w-[88%]">{turn.user}</p>}
      {(turn.steps.length > 0 || running) && <Steps turn={turn} running={running} />}
      {answer}
      {turn.changes.length > 0 && (
        <ul aria-label={t("Files changed in this turn")} className="flex flex-wrap gap-1.5">
          {turn.changes.map((c) => (
            <li key={c.path}>
              <button
                type="button"
                title={t("Open the diff of {path}", { path: c.path })}
                onClick={() => void openSessionFile(session, c.path)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-caption hover:bg-accent active:bg-pressed"
              >
                <FilePen className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono">{c.path}</span>
                <span className="shrink-0 tabular-nums">
                  {c.added > 0 && <span className="text-success">+{c.added}</span>}
                  {c.added > 0 && c.removed > 0 && " "}
                  {c.removed > 0 && <span className="text-destructive">−{c.removed}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {turn.errors.map((error, i) => (
        <div key={i} role="alert" className="flex items-start gap-3 rounded-md bg-destructive-subtle px-3 py-2 text-small text-destructive">
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</p>
          {onRetry && i === turn.errors.length - 1 && (
            <Button size="sm" variant="secondary" className="shrink-0" onClick={onRetry}>
              {t("Retry")}
            </Button>
          )}
        </div>
      ))}
      {endNote(turn) && <p className="text-caption text-faint-foreground">{endNote(turn)}</p>}
    </section>
  )
}

/**
 * Earlier turns stay as they are while the agent works on the last one, so they skip re-rendering.
 * Compared by what they show, since every update cuts the turns anew; a turn offering Retry
 * always renders (its callback is new each time).
 */
const TurnView = memo(
  TurnContent,
  (a, b) => !a.onRetry && !b.onRetry && a.running === b.running && a.session.project === b.session.project && a.session.tree === b.session.tree && sameTurn(a.turn, b.turn),
)

/** How a turn ended, when that needs saying. */
function endNote(turn: Turn): string | null {
  switch (turn.end) {
    case "cancelled":
      return t("You stopped this turn.")
    case "max_tokens":
      return t("Stopped: the model reached its output limit.")
    case "max_turn_requests":
      return t("Stopped: the turn reached its step limit.")
    case "refusal":
      return t("The model declined to continue.")
  }
  // An agent may simply stop when a step is refused: without this the turn would end in silence.
  const rejected = turn.steps.some((s) => s.kind === "ask" && !!s.options.find((o) => o.id === s.answer)?.kind.startsWith("reject"))
  return turn.end !== null && !turn.answer && rejected ? t("You rejected a step, so the turn ended there.") : null
}

function summaryText(c: StepCounts): string {
  const parts: string[] = []
  if (c.read) parts.push(tp("Read {n} file", "Read {n} files", c.read))
  if (c.edit) parts.push(tp("Edited {n} file", "Edited {n} files", c.edit))
  if (c.run) parts.push(tp("Ran {n} command", "Ran {n} commands", c.run))
  if (c.search) parts.push(tp("{n} search", "{n} searches", c.search))
  if (c.other) parts.push(tp("{n} other step", "{n} other steps", c.other))
  return parts.join(" · ") || t("Thought it through")
}

const isOpen = (s: Step) => s.kind === "tool" && (s.status === "pending" || s.status === "in_progress")

/** What the agent is doing right now, in a few words. */
function nowText(turn: Turn): string {
  // It waits for you, whatever tool call the permission is for.
  if (turn.steps.some((s) => s.kind === "ask" && s.answer === null)) return t("Waiting for your answer")
  const step = currentStep(turn)
  if (!step || step.kind === "thought") return t("Thinking…")
  if (step.kind !== "tool" || !isOpen(step)) return t("Working…")
  // A call that has just started has no file or command yet, only the tool's own name.
  const name = step.command ?? step.paths[0]
  switch (step.tool) {
    case "read":
      return name ? t("Reading {name}…", { name }) : t("Reading a file…")
    case "edit":
      return name ? t("Editing {name}…", { name }) : t("Editing a file…")
    case "execute":
      return name ? t("Running {name}…", { name }) : t("Running a command…")
    case "search":
      return t("Searching…")
    case "fetch":
      return name ? t("Fetching {name}…", { name }) : t("Working…")
    default:
      return t("Working…")
  }
}

/** The turn's process as one line; the steps themselves only when asked for. */
function Steps({ turn, running }: { turn: Turn; running: boolean }) {
  const [open, setOpen] = useState(false)
  const label = running ? nowText(turn) : summaryText(countSteps(turn))
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        disabled={!turn.steps.length}
        onClick={() => setOpen(!open)}
        className="group -mx-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-small text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground"
      >
        {running ? <Spinner className="size-3.5 shrink-0" /> : open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        {running && turn.steps.length > 0 && (open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />)}
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-1 border-l pl-3">
          {turn.steps.map((step) => (
            <li key={step.id}>
              <StepRow step={step} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ToolIcon({ tool }: { tool: string }) {
  const cls = "mt-0.5 size-3.5 shrink-0 text-faint-foreground"
  switch (tool) {
    case "read":
      return <FileText className={cls} />
    case "edit":
    case "delete":
    case "move":
      return <FilePen className={cls} />
    case "execute":
      return <SquareTerminal className={cls} />
    case "search":
      return <Search className={cls} />
    case "fetch":
      return <Globe className={cls} />
    default:
      return <Wrench className={cls} />
  }
}

function ToolStatus({ step }: { step: ToolItem }) {
  if (isOpen(step)) return <Spinner className="mt-0.5 size-3.5 shrink-0 text-faint-foreground" />
  if (step.status === "failed") return <span className="shrink-0 text-caption text-destructive">{t("Failed")}</span>
  if (step.status === "cancelled") return <span className="shrink-0 text-caption text-faint-foreground">{t("Not run")}</span>
  return null
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false)
  switch (step.kind) {
    case "thought":
      return <p className="whitespace-pre-wrap break-words text-caption text-faint-foreground">{step.text}</p>
    case "message":
      return <p className="whitespace-pre-wrap break-words text-small text-muted-foreground">{step.text}</p>
    case "plan":
      return (
        <ul className="flex flex-col gap-0.5 text-small">
          {step.entries.map((e, i) => (
            <li key={i} className={cn("flex items-start gap-2", e.status === "completed" ? "text-faint-foreground" : "text-muted-foreground")}>
              {e.status === "completed" ? <Check className="mt-0.5 size-3.5 shrink-0" /> : e.status === "in_progress" ? <Spinner className="mt-0.5 size-3.5 shrink-0" /> : <ListChecks className="mt-0.5 size-3.5 shrink-0 text-faint-foreground" />}
              <span className="min-w-0 break-words">{e.text}</span>
            </li>
          ))}
        </ul>
      )
    case "ask": {
      const chosen = step.options.find((o) => o.id === step.answer)
      const verdict = step.answer === null ? t("Waiting for your answer") : chosen ? optionLabel(chosen) : t("Not answered")
      return (
        <p className="flex items-start gap-2 text-caption text-faint-foreground">
          <CircleHelp className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {verdict} <span className="font-mono">{step.command ?? step.paths[0] ?? step.title}</span>
          </span>
        </p>
      )
    }
    case "tool": {
      const name = step.command ?? step.paths[0] ?? step.title
      // A command's output is worth a look; a file's contents are in the diff.
      const detail = step.tool === "execute" || step.status === "failed" ? step.output : null
      const diff = step.diffs.reduce((sum, d) => ({ added: sum.added + d.added, removed: sum.removed + d.removed }), { added: 0, removed: 0 })
      return (
        <div className="text-small">
          <button type="button" disabled={!detail} aria-expanded={detail ? open : undefined} onClick={() => setOpen(!open)} className="-mx-1 flex w-full items-start gap-2 rounded-sm px-1 text-left text-muted-foreground enabled:hover:bg-accent">
            <ToolIcon tool={step.tool} />
            <span className={cn("min-w-0 flex-1 break-words", (step.command || step.paths.length > 0) && "font-mono text-caption leading-5")}>{name}</span>
            {(diff.added > 0 || diff.removed > 0) && (
              <span className="shrink-0 text-caption tabular-nums">
                {diff.added > 0 && <span className="text-success">+{diff.added}</span>} {diff.removed > 0 && <span className="text-destructive">−{diff.removed}</span>}
              </span>
            )}
            <ToolStatus step={step} />
            {detail && (open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />)}
          </button>
          {open && detail && <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-sunken px-2.5 py-2 font-mono text-caption text-muted-foreground">{detail}</pre>}
        </div>
      )
    }
  }
}

function SetupLine({ setup }: { setup: SetupItem }) {
  const failed = setup.code !== null && setup.code !== 0
  // A failure is the whole story of the session: show it without a click.
  const [open, setOpen] = useState(false)
  const shown = open || failed
  return (
    <section className="text-small">
      <button type="button" aria-expanded={shown} disabled={!setup.output || failed} onClick={() => setOpen(!open)} className="-mx-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground">
        {setup.code === null ? <Spinner className="size-3.5 shrink-0" /> : failed ? <X className="size-3.5 shrink-0 text-destructive" /> : <Check className="size-3.5 shrink-0 text-success" />}
        <span className="shrink-0">{setup.code === null ? t("Running the setup command…") : failed ? t("The setup command failed (exit code {code})", { code: setup.code ?? "?" }) : t("Setup command finished")}</span>
        <span className="truncate font-mono text-caption text-faint-foreground">{setup.command.split("\n")[0]}</span>
        {setup.output && !failed && (shown ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />)}
      </button>
      {shown && setup.output && <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-sunken px-2.5 py-2 font-mono text-caption text-muted-foreground">{setup.output}</pre>}
    </section>
  )
}

// ---------- a permission ----------

/** The agent's options in Retrace's words; one it doesn't know keeps the agent's own name. */
function optionLabel(o: AgentAskOption): string {
  switch (o.kind) {
    case "allow_once":
      return t("Allow Once")
    case "allow_always":
      return t("Always Allow")
    case "reject_once":
      return t("Reject")
    case "reject_always":
      return t("Always Reject")
    default:
      return o.name || o.id
  }
}

function AskCard({ ask, session, agentName }: { ask: AskItem; session: AgentSession; agentName: string }) {
  const [sending, setSending] = useState<string | null>(null)
  const answer = async (option: string) => {
    setSending(option)
    try {
      await api.agentAnswer(session.id, ask.request, option)
      void pullChat(session.id)
    } catch (e) {
      notify.error(t("Couldn't send your answer: {reason}", { reason: message(e) }))
      setSending(null)
    }
  }
  const what = ask.command ?? ask.paths.join("\n")
  const title =
    ask.tool === "execute"
      ? t("{agent} wants to run a command", { agent: agentName })
      : ask.tool === "edit" || ask.tool === "delete" || ask.tool === "move"
        ? t("{agent} wants to change a file", { agent: agentName })
        : t("{agent} asks for permission: {what}", { agent: agentName, what: ask.title })
  // The first "allow once" is the one primary action; nothing here takes focus, so Enter in the message box can't approve it.
  const primary = ask.options.find((o) => o.kind === "allow_once")?.id
  return (
    <section aria-label={title} className="shrink-0 border-t bg-warning-subtle px-3 py-2.5">
      <div className="mx-auto flex max-w-[760px] flex-col gap-2">
        <p className="flex items-center gap-1.5 text-small font-medium">
          <CircleHelp className="size-3.5 shrink-0 text-warning" />
          {title}
        </p>
        {what && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2.5 py-2 font-mono text-caption">{what}</pre>}
        <div className="flex flex-wrap gap-1.5">
          {ask.options.map((o) => (
            <Button key={o.id} size="sm" variant={o.id === primary ? "primary" : "secondary"} loading={sending === o.id} disabled={sending !== null} onClick={() => void answer(o.id)}>
              {optionLabel(o)}
            </Button>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- the message box ----------

function Composer({
  session: s,
  agentName,
  busy,
  ready,
  options,
  usage,
  onSend,
}: {
  session: AgentSession
  agentName: string
  busy: boolean
  /** The conversation is open and can take a message. */
  ready: boolean
  options: AgentOption[]
  usage: { used: number; size: number } | null
  onSend: (text: string) => Promise<void>
}) {
  // Kept per session while unsent: closing the drawer or showing another session doesn't lose it.
  const [text, setText] = useState(() => drafts.get(s.id))
  const [sending, setSending] = useState(false)
  const send = async () => {
    const body = text.trim()
    if (!body || sending || busy || !ready) return
    setSending(true)
    try {
      await onSend(body)
      setText("")
      drafts.clear(s.id)
    } catch (e) {
      notify.error(t("Couldn't send the message: {reason}", { reason: message(e) }))
    } finally {
      setSending(false)
    }
  }
  const stop = () => void api.agentCancel(s.id).catch((e) => notify.error(message(e)))
  const pick = async (option: AgentOption, value: string) => {
    try {
      await api.agentSetOption(s.id, option.id, value)
      // Remembered for the next session with this agent.
      const next = rememberedOptions(options.map((o) => (o.id === option.id ? { ...o, value } : o)))
      prefs.set((p) => ({ agentOptions: { ...p.agentOptions, [s.agent]: { ...p.agentOptions[s.agent], ...next } } }))
      void pullChat(s.id)
    } catch (e) {
      notify.error(t("Couldn't change {name}: {reason}", { name: option.name, reason: message(e) }))
    }
  }
  return (
    <form
      className="shrink-0 border-t px-3 pb-2 pt-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <div className="mx-auto max-w-[760px]">
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            drafts.set(s.id, e.target.value)
          }}
          onKeyDown={(e) => {
            // Enter while an input method is composing picks a candidate; it doesn't send.
            if (e.key === "Enter" && !e.shiftKey && !isImeKey(e.nativeEvent)) {
              e.preventDefault()
              void send()
            }
          }}
          rows={1}
          aria-label={t("Message to {agent}", { agent: agentName })}
          placeholder={t("Message {agent} · ↩ to send, ⇧↩ for a new line", { agent: agentName })}
          className="max-h-48 min-h-0 resize-none py-1.5"
        />
        <div className="mt-1.5 flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {options.map((o) => (
              <OptionPicker key={o.id} option={o} disabled={busy || !ready} onPick={(value) => void pick(o, value)} />
            ))}
          </div>
          {usage && usage.size > 0 && (
            <span className="shrink-0 px-1 text-caption tabular-nums text-faint-foreground" title={t("Context in use: {used} of {size} tokens", { used: usage.used.toLocaleString(), size: usage.size.toLocaleString() })}>
              {compactNumber(usage.used)} / {compactNumber(usage.size)}
            </span>
          )}
          {busy ? (
            <IconButton label={t("Stop This Turn")} type="button" variant="secondary" size="icon-sm" onClick={stop}>
              <Square />
            </IconButton>
          ) : (
            <IconButton label={t("Send")} type="submit" variant="primary" size="icon-sm" disabled={!ready || !text.trim()} loading={sending}>
              <ArrowUp />
            </IconButton>
          )}
        </div>
      </div>
    </form>
  )
}

/** One of the agent's own settings (model, mode, effort) as a small picker; a long list gets a filter. */
function OptionPicker({ option, disabled, onPick }: { option: AgentOption; disabled: boolean; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const name = option.choices.find((c) => c.value === option.value)?.name ?? option.value
  const filterable = option.choices.length > FILTER_FROM
  const q = query.trim().toLowerCase()
  const shown = q ? option.choices.filter((c) => c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)) : option.choices
  const choose = (value: string) => {
    setOpen(false)
    if (value !== option.value) onPick(value)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(0, Math.min(shown.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))))
    } else if (e.key === "Enter" && !isImeKey(e.nativeEvent)) {
      e.preventDefault()
      const pick = shown[active]
      if (pick) choose(pick.value)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery("")
          setActive(Math.max(0, option.choices.findIndex((c) => c.value === option.value)))
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} title={name} aria-label={`${option.name} ${name}`} className="min-w-0 max-w-[220px] gap-1 px-1.5 text-caption font-normal text-muted-foreground">
          {/* "Provider/Model": the model is the part worth the room. */}
          <span className="truncate">{name.slice(name.lastIndexOf("/") + 1)}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-1" onKeyDown={onKey}>
        <p className="px-2 pb-1 pt-1.5 text-caption text-faint-foreground">{option.name}</p>
        {filterable && (
          <div className="px-1 pb-1">
            <Input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              placeholder={t("Filter")}
              aria-label={t("Filter {name}", { name: option.name })}
              className="h-(--control-sm) text-small"
            />
          </div>
        )}
        <ul role="listbox" aria-label={option.name} className="max-h-72 overflow-y-auto">
          {shown.map((c, i) => (
            <li key={c.value} role="option" aria-selected={c.value === option.value}>
              <button
                type="button"
                ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(c.value)}
                className={cn("flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-small", i === active && "bg-accent")}
              >
                <Check className={cn("mt-0.5 size-3.5 shrink-0", c.value !== option.value && "invisible")} />
                <span className="min-w-0 flex-1">
                  <span className="block break-words">{c.name}</span>
                  {c.description && <span className="block text-caption text-faint-foreground">{c.description}</span>}
                </span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="px-2 py-3 text-center text-small text-faint-foreground">{t("No match")}</li>}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
