// Quitting or restarting while agents run ends them, so ask first. The menu's Quit, closing the
// window and the update's Restart all come through here.

import { api, inTauri } from "./api"
import { createStore } from "./store"

export type Leave = "quit" | "restart"

/** A pending question: quit or restart with `running` agents still going. */
export const leaving = createStore<{ ask: Leave | null; running: number }>({ ask: null, running: 0 })

export async function runningAgents(): Promise<number> {
  try {
    return (await api.agentSessions()).filter((s) => s.running).length
  } catch {
    return 0
  }
}

/** Quit or restart now, or ask first when agents are running. */
export async function leave(kind: Leave, confirmed = false) {
  if (!inTauri) return
  if (!confirmed) {
    const running = await runningAgents()
    if (running > 0) return leaving.set({ ask: kind, running })
  }
  const process = await import("@tauri-apps/plugin-process")
  if (kind === "restart") await process.relaunch()
  else await process.exit(0)
}

/** Closing the main window quits the app: the same question first. */
export async function guardWindowClose(): Promise<() => void> {
  if (!inTauri) return () => {}
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow().onCloseRequested(async (e) => {
    const running = await runningAgents()
    if (running === 0) return
    e.preventDefault()
    leaving.set({ ask: "quit", running })
  })
}
