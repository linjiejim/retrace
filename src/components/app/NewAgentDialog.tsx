import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { defaultBranch, worktreePath } from "@/lib/agent-state"
import { openSession } from "@/lib/commands"
import { tildify } from "@/lib/format"
import { t } from "@/lib/i18n"
import { prefs, ui, useStore } from "@/lib/store"
import { ensureTerminal, START_COLS, START_ROWS } from "@/lib/terminals"
import type { AgentSession } from "@/lib/types"
import { useInstalledAgents } from "@/hooks/agents"
import { useOverview, useProjects } from "@/hooks/queries"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog"
import { Field, FieldGroup } from "@/components/ui/field"
import { Input, Textarea } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StateView } from "@/components/ui/state"

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Where = "new" | "current"

export function NewAgentDialog() {
  const qc = useQueryClient()
  const req = useStore(ui, (s) => s.newAgent)
  const projectId = req?.projectId ?? null
  const project = useProjects().data?.find((p) => p.id === projectId)
  const overview = useOverview(projectId)
  const installed = useInstalledAgents()
  const lastAgent = useStore(prefs, (s) => s.lastAgent)
  const tabKey = useStore(ui, (s) => (projectId ? s.tabs[projectId] : undefined))
  const savedSetup = useQuery({ queryKey: ["agentSetup", projectId], queryFn: () => api.agentSetup(projectId!), enabled: !!projectId, staleTime: 0 })

  const [task, setTask] = useState("")
  const [agent, setAgent] = useState("")
  const [where, setWhere] = useState<Where>("new")
  const [branch, setBranch] = useState("")
  const [branchEdited, setBranchEdited] = useState(false)
  const [setup, setSetup] = useState("")
  const [setupEdited, setSetupEdited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Every opening starts from a clean form, and looks for agents again (one may be new).
  useEffect(() => {
    if (!req) return
    void qc.invalidateQueries({ queryKey: ["agentKinds"] })
    setTask("")
    setWhere("new")
    setBranch(defaultBranch("", new Date()))
    setBranchEdited(false)
    setSetup(savedSetup.data ?? "")
    setSetupEdited(false)
    setError(null)
    setPending(false)
  }, [req, qc])

  useEffect(() => {
    if (!installed.length) return
    setAgent((a) => (installed.some((k) => k.id === a) ? a : installed.find((k) => k.id === lastAgent)?.id ?? installed.find((k) => k.id === "opencode")?.id ?? installed[0].id))
  }, [installed, lastAgent])

  useEffect(() => {
    if (!setupEdited && savedSetup.data !== undefined) setSetup(savedSetup.data ?? "")
  }, [savedSetup.data, setupEdited])

  // The worktree the current tab shows (branch tabs and unknown tabs: the main one).
  const current = useMemo(() => {
    const trees = overview.data?.trees.filter((tr) => !tr.bare) ?? []
    const fromTab = tabKey?.startsWith("tree:") ? trees.find((tr) => tr.path === tabKey.slice(5)) : undefined
    return fromTab ?? trees.find((tr) => tr.isMain) ?? null
  }, [overview.data, tabKey])
  const currentLabel = current ? (current.branch ?? current.path.split("/").pop() ?? current.path) : ""
  const trunk = overview.data?.trunk?.name

  const close = () => ui.set({ newAgent: null })

  async function start() {
    if (!projectId || !agent || pending) return
    if (where === "new" && !branch.trim()) return setError(t("A new worktree needs a branch name"))
    setPending(true)
    setError(null)
    try {
      const s = await api.agentStart({
        id: projectId,
        agent,
        task: task.trim(),
        tree: where === "current" ? (current?.path ?? null) : null,
        branch: where === "new" ? branch.trim() : null,
        setup: where === "new" ? setup : null,
        cols: START_COLS,
        rows: START_ROWS,
      })
      // At once, so the agent's first terminal queries get answers.
      ensureTerminal(s.id)
      qc.setQueryData<AgentSession[]>(["agents"], (old) => [...(old ?? []).filter((x) => x.id !== s.id), s])
      void qc.invalidateQueries({ queryKey: ["agents"] })
      void qc.invalidateQueries({ queryKey: ["agentSetup", projectId] })
      prefs.set({ lastAgent: agent })
      close()
      openSession(s)
    } catch (e) {
      setError(message(e))
      setPending(false)
    }
  }

  const options = installed.map((k) => ({ value: k.id, label: k.name }))
  const newTree = where === "new"

  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && close()} dirty={!!task.trim() && !pending}>
      <DialogContent size="md">
        <DialogHeader title={t("New Agent Session")} description={project?.name} />
        {installed.length === 0 ? (
          <DialogBody className="pb-5">
            <StateView size="sm" kind="empty" title={t("No coding agent found")} description={t("Install OpenCode, Codex or Claude Code so your login shell finds it, then open this again.")} />
          </DialogBody>
        ) : (
          <>
            <DialogBody>
              <form
                id="new-agent"
                onSubmit={(e) => {
                  e.preventDefault()
                  void start()
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void start()
                  }
                }}
              >
                <FieldGroup>
                  <Field label={t("Task")} hint={t("Optional: you can also type it in the terminal.")}>
                    <Textarea
                      autoFocus
                      rows={4}
                      value={task}
                      onChange={(e) => {
                        setTask(e.target.value)
                        if (!branchEdited) setBranch(defaultBranch(e.target.value, new Date()))
                      }}
                      placeholder={t("What should the agent do?")}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("Agent")}>
                      <Select options={options} value={agent} onValueChange={setAgent} />
                    </Field>
                    <Field label={t("Run in")}>
                      <Select
                        options={[
                          { value: "new", label: t("A new worktree") },
                          { value: "current", label: t("This worktree ({name})", { name: currentLabel }), disabled: !current },
                        ]}
                        value={where}
                        onValueChange={(v) => setWhere(v as Where)}
                      />
                    </Field>
                  </div>
                  <Field
                    label={t("Branch")}
                    hint={
                      newTree && projectId && branch.trim()
                        ? `${tildify(worktreePath(projectId, branch.trim()))}${trunk ? ` · ${t("from {branch}", { branch: trunk })}` : ""}`
                        : t("Runs in {name} as it is.", { name: currentLabel })
                    }
                  >
                    <Input
                      value={newTree ? branch : (current?.branch ?? "")}
                      disabled={!newTree}
                      spellCheck={false}
                      onChange={(e) => {
                        setBranch(e.target.value)
                        setBranchEdited(true)
                      }}
                      className="font-mono"
                    />
                  </Field>
                  <Field label={t("Setup command")} info={t('Runs in the new worktree before the agent starts; the agent starts only if it succeeds. $RETRACE_MAIN_TREE is the main worktree, e.g. cp "$RETRACE_MAIN_TREE/.env" .')} hint={newTree ? t("Remembered for this project.") : t("Only for a new worktree.")}>
                    <Input
                      value={newTree ? setup : ""}
                      disabled={!newTree}
                      spellCheck={false}
                      placeholder={t("e.g. pnpm install")}
                      onChange={(e) => {
                        setSetup(e.target.value)
                        setSetupEdited(true)
                      }}
                      className="font-mono"
                    />
                  </Field>
                </FieldGroup>
              </form>
              {error && (
                <p role="alert" className="mt-4 rounded-md bg-destructive-subtle px-3 py-2 text-small text-destructive">
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={close} disabled={pending}>
                {t("Cancel")}
              </Button>
              <Button variant="primary" type="submit" form="new-agent" loading={pending} disabled={!agent}>
                {t("Start Session")}
                <span className="text-caption opacity-70">⌘↩</span>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
