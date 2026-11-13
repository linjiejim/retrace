// Quitting or restarting while agents run: terminal sessions end with Retrace, so ask first;
// sessions on OpenCode's server keep going unless the user says to stop them. The menu's Quit,
// closing the window and the update's Restart all come through here.

import { api, inTauri } from "./api"
import { createStore } from "./store"
import { t } from "./i18n"
import type { AgentSession } from "./types"
import { notify } from "@/components/ui/toast"

export type Leave = "quit" | "restart"

/** What quitting would do to the sessions: `ending` stop with Retrace, `continuing` go on in the background. */
export interface QuitCounts {
  ending: number
  continuing: number
}

/** A pending question: quit or restart with agents still at work. */
export const leaving = createStore<{ ask: Leave | null } & QuitCounts>({ ask: null, ending: 0, continuing: 0 })

/**
 * Running terminal sessions end; background ones that are mid-turn or waiting for an answer carry
 * on. One still running its setup command (not on OpenCode's server yet) ends: the setup is Retrace's.
 */
export function quitCounts(sessions: AgentSession[]): QuitCounts {
  const running = sessions.filter((s) => s.running)
  const onServer = (s: AgentSession) => s.background && !!s.nativeId
  return {
    ending: running.filter((s) => !onServer(s)).length,
    continuing: running.filter((s) => onServer(s) && (s.live?.state === "busy" || s.live?.state === "asking")).length,
  }
}

async function counts(): Promise<QuitCounts> {
  return quitCounts(await api.agentSessions())
}

/**
 * Quit or restart now, or ask first when agents are at work. `stopBackground`: the user chose to
 * stop the background sessions too.
 */
export async function leave(kind: Leave, confirmed = false, stopBackground = false) {
  if (!inTauri) return
  if (!confirmed) {
    try {
      const c = await counts()
      if (c.ending > 0 || c.continuing > 0) return leaving.set({ ask: kind, ...c })
    } catch {
      notify.error(t("Couldn't check running sessions. Try quitting again."))
      return
    }
  }
  if (stopBackground) await api.agentStopBackground()
  const process = await import("@tauri-apps/plugin-process")
  if (kind === "restart") await process.relaunch()
  else await process.exit(0)
}

/** Closing the main window quits the app: the same question first. */
export async function guardWindowClose(): Promise<() => void> {
  if (!inTauri) return () => {}
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow().onCloseRequested(async (e) => {
    e.preventDefault()
    try {
      const c = await counts()
      if (c.ending === 0 && c.continuing === 0) await getCurrentWindow().destroy()
      else leaving.set({ ask: "quit", ...c })
    } catch {
      notify.error(t("Couldn't check running sessions. Try quitting again."))
    }
  })
}
