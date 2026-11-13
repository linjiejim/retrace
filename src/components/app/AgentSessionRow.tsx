import { RotateCcw, CircleAlert, CircleCheck, CircleDot, CircleHelp, CircleStop, Code, Ellipsis, FolderOpen, Square, SquareTerminal, TriangleAlert, X } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { agentState, canResume, resumesDirectly, sessionLabel, short, STATE_LABEL, stateDetail, type AgentState } from "@/lib/agent-state"
import { openSession } from "@/lib/commands"
import { t } from "@/lib/i18n"
import { prefs, ui, useStore } from "@/lib/store"
import type { AgentKind, AgentSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip } from "@/components/ui/tooltip"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { notify } from "@/components/ui/toast"

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Shape and colour both say the state: spinner, yellow dot or question mark (your move), red triangle (the agent hit an error), check, stop, alert. */
export function AgentStateIcon({ state, className }: { state: AgentState; className?: string }) {
  const label = t(STATE_LABEL[state])
  switch (state) {
    case "working":
      return <Spinner label={label} className={cn("size-3.5 text-muted-foreground", className)} />
    case "waiting":
      return <CircleDot role="img" aria-label={label} className={cn("size-3.5 text-warning", className)} />
    case "asking":
      return <CircleHelp role="img" aria-label={label} className={cn("size-3.5 text-warning", className)} />
    case "errored":
      return <TriangleAlert role="img" aria-label={label} className={cn("size-3.5 text-destructive", className)} />
    case "done":
      return <CircleCheck role="img" aria-label={label} className={cn("size-3.5 text-success", className)} />
    case "stopped":
      return <CircleStop role="img" aria-label={label} className={cn("size-3.5 text-faint-foreground", className)} />
    case "failed":
      return <CircleAlert role="img" aria-label={label} className={cn("size-3.5 text-destructive", className)} />
  }
}

export const fallbackLabel = (name: string) => t("{agent} session", { agent: name })

/** Stop and close, asking first when it would end a running agent. */
export function useSessionActions(s: AgentSession, label: string) {
  const qc = useQueryClient()
  const { confirm, element } = useConfirm()
  const refresh = () => qc.invalidateQueries({ queryKey: ["agents"] })
  const stop = () =>
    void confirm({
      title: t("Stop “{name}”?", { name: short(label) }),
      description: s.background ? t("The turn in progress stops. The conversation stays in OpenCode and can be resumed; the worktree and changes stay.") : t("The agent's process ends. Its worktree and changes stay."),
      confirmLabel: t("Stop Agent"),
      tone: "danger",
      onConfirm: async () => {
        await api.agentStop(s.id)
        await refresh()
      },
    })
  const close = async () => {
    const forget = async () => {
      await api.agentClose(s.id)
      // The drawer showed this session: nothing left to show, so it closes too.
      if (ui.get().agentSession === s.id) ui.set({ agentSession: null, agentOpen: false })
      await refresh()
    }
    if (!s.running) return forget().catch((e) => notify.error(message(e)))
    await confirm({
      title: t("Close “{name}”?", { name: short(label) }),
      description: s.background ? t("Closing stops the turn in progress and removes the session from the list. The conversation stays in OpenCode; the worktree and changes stay.") : t("The agent is still running; closing the session ends it. Its worktree and changes stay."),
      confirmLabel: t("End and Close"),
      tone: "danger",
      onConfirm: forget,
    })
  }
  const resume = async () => {
    try {
      const resumed = await api.agentResume(s.id, prefs.get().agentOptions[s.agent] ?? null)
      await refresh()
      openSession(resumed)
    } catch (e) {
      notify.error(t("Couldn't resume the session: {reason}", { reason: message(e) }))
    }
  }
  return { stop, close, resume, element }
}

/**
 * `guide`: where its project's tree line runs (the middle of the project's fold arrow); `indent`:
 * where the row's own content starts; `last`: the last session, where that line ends.
 */
export function AgentSessionRow({ session: s, kinds, now, guide, indent, last }: { session: AgentSession; kinds: AgentKind[] | undefined; now: number; guide: number; indent: number; last: boolean }) {
  const state = agentState(s, now)
  const label = sessionLabel(s, kinds, fallbackLabel)
  const agentName = kinds?.find((k) => k.id === s.agent)?.name ?? s.agent
  const selected = useStore(ui, (u) => u.agentOpen && u.agentSession === s.id)
  const { stop, close, resume, element } = useSessionActions(s, label)
  const open = (how: "finder" | "terminal" | "editor") => api.open(s.project, s.tree, how).catch((e) => notify.error(message(e)))
  const detail = stateDetail(s, state)
  const tip = [s.task.trim() || label, `${t(STATE_LABEL[state])}${detail ? `: ${detail}` : ""}${s.exitCode !== null && s.exitCode !== 0 && !s.stopped ? ` (${t("exit code {code}", { code: s.exitCode })})` : ""}`, [agentName, s.branch].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join("\n")

  const items = (Item: typeof DropdownMenuItem | typeof ContextMenuItem, Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator) => (
    <>
      <Item onSelect={() => open("finder")}>
        <FolderOpen />
        {t("Show Worktree in Finder")}
      </Item>
      <Item onSelect={() => open("terminal")}>
        <SquareTerminal />
        {t("Open in Terminal")}
      </Item>
      <Item onSelect={() => open("editor")}>
        <Code />
        {t("Open in Editor")}
      </Item>
      <Separator />
      {canResume(s) && (
        <Item onSelect={() => void resume()}>
          <RotateCcw />
          {resumesDirectly(s, kinds) ? t("Resume Session") : t("Resume Session…")}
        </Item>
      )}
      {s.running && (
        <Item onSelect={stop}>
          <Square />
          {t("Stop Agent")}
        </Item>
      )}
      <Item onSelect={() => void close()}>
        <X />
        {t("Close Session")}
      </Item>
    </>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <li
            className={cn(
              "group relative flex h-7 cursor-default select-none items-center gap-1.5 rounded-sm pr-1 text-small text-muted-foreground hover:bg-accent",
              selected && "bg-pressed text-foreground hover:bg-pressed",
            )}
            style={{ paddingLeft: indent }}
            // The one already open: clicking it again puts the drawer away.
            onClick={() => (ui.get().agentOpen && ui.get().agentSession === s.id ? ui.set({ agentOpen: false }) : openSession(s))}
          >
            {/* The tree line from the project down to this session (ending here if it's the last), and its branch. */}
            <span aria-hidden className={cn("pointer-events-none absolute top-0 w-px bg-border", last ? "h-1/2" : "bottom-0")} style={{ left: guide }} />
            <span aria-hidden className="pointer-events-none absolute top-1/2 h-px bg-border" style={{ left: guide, width: indent - guide - 2 }} />
            <AgentStateIcon state={state} className="shrink-0" />
            <Tooltip content={<span className="whitespace-pre-line">{tip}</span>} side="right">
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </Tooltip>
            <span className="shrink-0 text-caption text-faint-foreground group-hover:hidden">{agentName}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={t("More actions for {name}", { name: label })}
                  onClick={(e) => e.stopPropagation()}
                  className="hidden size-5 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:bg-pressed hover:text-foreground group-hover:inline-flex data-[state=open]:inline-flex"
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
                {items(DropdownMenuItem, DropdownMenuSeparator)}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        </ContextMenuTrigger>
        <ContextMenuContent>{items(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
      </ContextMenu>
      {element}
    </>
  )
}
