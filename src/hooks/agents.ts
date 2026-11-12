import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api, inTauri } from "@/lib/api"
import type { AgentKind } from "@/lib/types"

const NO_KINDS: AgentKind[] = []

/** The agents Retrace knows; none when this build or bridge can't start them. */
export const useAgentKinds = () =>
  useQuery({
    queryKey: ["agentKinds"],
    queryFn: () => api.agentKinds().catch(() => NO_KINDS),
    staleTime: Infinity,
  })

/** Only the installed ones. */
export function useInstalledAgents(): AgentKind[] {
  const kinds = useAgentKinds().data ?? NO_KINDS
  return kinds.filter((k) => k.path)
}

/** Running sessions are polled for their state; the app also refreshes on `agent-changed` (the browser dev bridge has no events, so it always polls). */
export const useAgentSessions = () =>
  useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agentSessions().catch(() => []),
    refetchInterval: (q) => (!inTauri ? 1500 : q.state.data?.some((s) => s.running) ? 2000 : false),
    refetchIntervalInBackground: true,
  })

/** The current time, ticking every `ms` while `on` (session states depend on it). */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}
