import { lazy, Suspense } from "react"
import { ChevronDown, ChevronRight, ChevronUp, Columns2, Copy, ExternalLink, FileText, Files, GitCompareArrows, GitPullRequest, History, Maximize2, Minimize2, Rows2, WrapText, X } from "lucide-react"
import { copyText } from "@/lib/api"
import { closeDiff, openFile, openLink, openPullRequest, showFileHistory } from "@/lib/commands"
import { prNumber, prUrl } from "@/lib/github"
import { isImage, isMarkdown, isSvg } from "@/lib/filetype"
import { absoluteTime, shortHash } from "@/lib/format"
import { keyNav } from "@/lib/keys"
import { prefs, ui, useStore } from "@/lib/store"
import { STATUS_LETTER } from "@/lib/tree"
import type { FileChange, Target, Trunk } from "@/lib/types"
import { cn } from "@/lib/utils"
import { t, tp } from "@/lib/i18n"
import { useCachedPullRequests, useChanges, useCommit, useOverview } from "@/hooks/queries"
import { targetOf, useProjectView } from "@/hooks/use-project-view"
import { Button, IconButton } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip } from "@/components/ui/tooltip"
import { notify } from "@/components/ui/toast"
import { PanelHeader } from "@/components/layout/LayoutView"
import { STATUS_TONE } from "./ChangesPanel"
import { RefPills } from "./GraphPanel"
import { FilePreview, ImageCompare } from "./Preview"
import { PrInfo } from "./PullRequests"

// @pierre/diffs + Shiki are the heaviest part of the app: load them after first paint.
const Pool = lazy(() => import("./DiffViews").then((m) => ({ default: m.Pool })))
const SingleDiff = lazy(() => import("./DiffViews").then((m) => ({ default: m.SingleDiff })))
const ContinuousDiff = lazy(() => import("./DiffViews").then((m) => ({ default: m.ContinuousDiff })))

/**
 * The area under the graph: the diff of the picked change, or (when the left view lists all files)
 * a preview of the picked file. A selected commit shows its message on top.
 */
export function DiffPanel() {
  const { projectId, tab, trunk } = useProjectView()
  const selection = useStore(ui, (s) => s.selection)
  const mode = useStore(prefs, (s) => s.changesMode)
  const target = targetOf(selection, tab, trunk)
  const changes = useChanges(projectId, target)
  const info =
    projectId && selection?.kind === "commit" ? (
      <CommitInfo projectId={projectId} hash={selection.hash} trunk={trunk} />
    ) : projectId && selection?.kind === "compare" && tab?.kind === "pr" && tab.pr ? (
      <PrInfo projectId={projectId} pr={tab.pr} target={target} />
    ) : null

  return (
    <section className="flex h-full min-w-0 flex-col">
      {mode === "files" ? (
        <PreviewArea projectId={projectId} target={target} changes={changes.data} info={info} />
      ) : (
        <DiffArea projectId={projectId} target={target} files={changes.data} info={info} />
      )}
    </section>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center px-6 text-center text-small text-faint-foreground">{children}</div>
}

/** Repository path, ellipsised from the left so the file name stays visible. */
function PathLabel({ path, from }: { path: string; from?: string | null }) {
  const dir = path.split("/").slice(0, -1).join("/")
  const name = path.split("/").pop()
  return (
    <span className="selectable min-w-0 flex-1 truncate font-mono text-caption [direction:rtl] [text-align:left]">
      <span className="[unicode-bidi:plaintext]">
        {from && from !== path && <span className="text-faint-foreground">{from} → </span>}
        <span className="text-faint-foreground">{dir ? `${dir}/` : ""}</span>
        <span className="text-foreground">{name}</span>
      </span>
    </span>
  )
}

function StepButtons() {
  const order = useStore(ui, (s) => s.fileOrder)
  const mode = useStore(prefs, (s) => s.changesMode)
  const current = useStore(ui, (s) => (mode === "files" ? s.preview : s.file?.path))
  const index = current ? order.indexOf(current) : -1
  return (
    <>
      <IconButton label={`${t("Previous file")}  ↑`} size="icon-sm" disabled={index <= 0} onClick={() => keyNav.changes?.(-1)}>
        <ChevronUp />
      </IconButton>
      <IconButton label={`${t("Next file")}  ↓`} size="icon-sm" disabled={order.length === 0 || index >= order.length - 1} onClick={() => keyNav.changes?.(1)}>
        <ChevronDown />
      </IconButton>
    </>
  )
}

/** Narrows the graph to the commits that changed this file, or back to all of them. */
function HistoryButton({ path }: { path: string }) {
  const on = useStore(ui, (s) => s.historyFile === path)
  return (
    <IconButton
      label={on ? t("Show all commits") : t("Only commits that changed this file")}
      size="icon-sm"
      aria-pressed={on}
      className={cn(on && "bg-pressed text-primary")}
      onClick={() => showFileHistory(on ? null : path)}
    >
      <History />
    </IconButton>
  )
}

function CloseButton() {
  const focusMode = useStore(ui, (s) => s.focusMode)
  return (
    <>
      <IconButton
        label={`${focusMode ? t("Leave focus") : t("Focus: only changes and the diff")}  F`}
        size="icon-sm"
        className={cn("@max-[400px]/header:hidden", focusMode && "bg-pressed")}
        onClick={() => ui.set({ focusMode: !focusMode, diffOpen: true })}
      >
        {focusMode ? <Minimize2 /> : <Maximize2 />}
      </IconButton>
      <IconButton label={`${t("Close")}  Esc`} size="icon-sm" onClick={closeDiff}>
        <X />
      </IconButton>
    </>
  )
}

// ---------- diff ----------

/** `files` is undefined while the selection's changes load. */
function DiffArea({ projectId, target, files: loaded, info }: { projectId: string | null; target: Target | null; files: FileChange[] | undefined; info: React.ReactNode }) {
  const file = useStore(ui, (s) => s.file)
  const diffStyle = useStore(prefs, (s) => s.diffStyle)
  const diffView = useStore(prefs, (s) => s.diffView)
  const wrap = useStore(prefs, (s) => s.wrap)
  const files = loaded ?? []
  const change = files.find((f) => f.path === file?.path)

  return (
    <>
      <PanelHeader className="gap-1">
        {change && <span className={cn("w-3.5 shrink-0 text-center font-mono text-caption font-semibold", STATUS_TONE[change.status])}>{STATUS_LETTER[change.status]}</span>}
        {file ? <PathLabel path={file.path} from={change?.oldPath} /> : <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">{diffView === "all" && files.length ? tp("All {n} file", "All {n} files", files.length) : t("Diff")}</span>}
        {file && diffView === "file" && <HistoryButton path={file.path} />}
        <StepButtons />
        <span className="@max-[560px]/header:hidden">
          <Segmented
            size="sm"
            aria-label={t("Reading mode")}
            value={diffView}
            onValueChange={(v) => prefs.set({ diffView: v })}
            options={[
              { value: "file", label: <span className="sr-only">{t("One file")}</span>, icon: <FileText /> },
              { value: "all", label: <span className="sr-only">{t("All files, continuously")}</span>, icon: <Files /> },
            ]}
          />
        </span>
        <span className="@max-[460px]/header:hidden">
          <Segmented
            size="sm"
            aria-label={t("Diff layout")}
            value={diffStyle}
            onValueChange={(v) => prefs.set({ diffStyle: v })}
            options={[
              { value: "split", label: <span className="sr-only">{t("Side by side")}</span>, icon: <Columns2 /> },
              { value: "unified", label: <span className="sr-only">{t("Unified")}</span>, icon: <Rows2 /> },
            ]}
          />
        </span>
        <IconButton label={wrap ? t("Don't wrap lines") : t("Wrap lines")} size="icon-sm" className={cn("@max-[520px]/header:hidden", wrap && "bg-pressed")} onClick={() => prefs.set({ wrap: !wrap })}>
          <WrapText />
        </IconButton>
        <CloseButton />
      </PanelHeader>
      {info}
      <div className="selectable relative min-h-0 flex-1 overflow-hidden">
        {!projectId || !target ? (
          <Hint>{t("Pick a commit or the uncommitted changes")}</Hint>
        ) : (
          <Suspense fallback={null}>
            <Pool>
              {diffView === "all" ? (
                <ContinuousDiff projectId={projectId} target={target} files={files} />
              ) : !change ? (
                loaded && <Hint>{files.length ? t("Pick a file in Changes") : t("No file changes")}</Hint>
              ) : isImage(change.path) && !isSvg(change.path) ? (
                <ImageCompare projectId={projectId} target={target} change={change} />
              ) : (
                <SingleDiff projectId={projectId} target={target} change={change} />
              )}
            </Pool>
          </Suspense>
        )}
      </div>
    </>
  )
}

// ---------- preview ----------

function PreviewArea({ projectId, target, changes, info }: { projectId: string | null; target: Target | null; changes: FileChange[] | undefined; info: React.ReactNode }) {
  const path = useStore(ui, (s) => s.preview)
  const rendered = useStore(prefs, (s) => s.rendered)
  const change = path ? changes?.find((c) => c.path === path) : undefined
  const renderable = !!path && (isMarkdown(path) || isSvg(path))

  return (
    <>
      <PanelHeader className="gap-1">
        {path ? <PathLabel path={path} /> : <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">{t("Preview")}</span>}
        {change && (
          <Tooltip content={t("This file changed in the selected version: switch to Changes and see its diff")}>
            <Button
              size="sm"
              variant="ghost"
              className="@max-[460px]/header:hidden"
              onClick={() => {
                prefs.set({ changesMode: "changes" })
                openFile({ path: change.path, oldPath: change.oldPath })
              }}
            >
              <GitCompareArrows />
              {t("See changes")}
            </Button>
          </Tooltip>
        )}
        {path && <HistoryButton path={path} />}
        {renderable && (
          <Segmented
            size="sm"
            aria-label={t("Preview mode")}
            value={rendered ? "rendered" : "source"}
            onValueChange={(v) => prefs.set({ rendered: v === "rendered" })}
            options={[
              { value: "rendered", label: t("Rendered") },
              { value: "source", label: t("Source") },
            ]}
          />
        )}
        <StepButtons />
        <CloseButton />
      </PanelHeader>
      {info}
      <div className="selectable relative min-h-0 flex-1 overflow-hidden">
        {!projectId || !target ? (
          <Hint>{t("Pick a commit or the uncommitted changes")}</Hint>
        ) : !path ? (
          <Hint>{t("Pick a file on the left to preview it")}</Hint>
        ) : (
          <Suspense fallback={null}>
            <Pool>
              <FilePreview key={path} projectId={projectId} target={target} path={path} />
            </Pool>
          </Suspense>
        )}
      </div>
    </>
  )
}

// ---------- commit message ----------

function CommitInfo({ projectId, hash, trunk }: { projectId: string; hash: string; trunk: Trunk | null }) {
  const commit = useCommit(projectId, hash)
  const overview = useOverview(projectId)
  const showBody = useStore(prefs, (s) => s.commitBody)
  const c = commit.data
  const pr = c ? prNumber(c.subject) : null
  const webUrl = overview.data?.webUrl
  // Without a working gh the PR can't be read here: the button goes to the browser as before.
  const pulls = useCachedPullRequests(projectId).data
  const inApp = !pulls || pulls.state === "ok"

  return (
    <div className="selectable max-h-[40%] shrink-0 overflow-y-auto border-b px-3 py-2">
      {commit.isError ? (
        <div className="text-caption text-destructive">{commit.error.message}</div>
      ) : !c ? (
        <div className="space-y-2 py-1">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : (
        <>
          <div className="flex items-start gap-1">
            {c.body && (
              <Tooltip content={showBody ? t("Hide the message") : t("Show the message")}>
                <button
                  aria-label={showBody ? t("Hide the message") : t("Show the message")}
                  aria-expanded={showBody}
                  onClick={() => prefs.set({ commitBody: !showBody })}
                  className="-ml-1 mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight className={cn("size-3.5 transition-transform duration-(--duration-fast)", showBody && "rotate-90")} />
                </button>
              </Tooltip>
            )}
            <h2 className="min-w-0 flex-1 text-body font-semibold [overflow-wrap:anywhere]">{c.subject}</h2>
            {pr && webUrl && !inApp && (
              <Tooltip content={t("Open PR #{n} in the browser", { n: pr })}>
                <Button size="sm" variant="ghost" className="-my-1 -mr-1.5 shrink-0" onClick={() => openLink(prUrl(webUrl, pr))}>
                  <GitPullRequest />
                  PR #{pr}
                </Button>
              </Tooltip>
            )}
            {pr && webUrl && inApp && (
              <span className="-my-1 -mr-1.5 inline-flex shrink-0 items-center">
                <Tooltip content={t("See PR #{n} here", { n: pr })}>
                  <Button size="sm" variant="ghost" onClick={() => openPullRequest(pr)}>
                    <GitPullRequest />
                    PR #{pr}
                  </Button>
                </Tooltip>
                <IconButton label={t("Open PR #{n} in the browser", { n: pr })} size="icon-sm" className="text-faint-foreground" onClick={() => openLink(prUrl(webUrl, pr))}>
                  <ExternalLink />
                </IconButton>
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-caption text-faint-foreground">
            <Tooltip content={t("Copy the full hash")}>
              <button
                onClick={() => copyText(c.hash).then(() => notify.success(t("Copied {hash}", { hash: shortHash(c.hash) })))}
                className="inline-flex items-center gap-1 rounded-xs px-0.5 font-mono text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {shortHash(c.hash)}
                <Copy className="size-3" />
              </button>
            </Tooltip>
            <span>·</span>
            <Tooltip content={c.email}>
              <span>{c.author}</span>
            </Tooltip>
            <span>·</span>
            <span>{absoluteTime(c.authorTime)}</span>
            {c.committer !== c.author && <span>· {t("committed by {name}", { name: c.committer })}</span>}
            <span>·</span>
            <span>
              {c.parents.length > 1 ? `${t("Merge commit, compared with its first parent")} ` : c.parents.length ? `${t("Parent")} ` : t("Root commit")}
              {c.parents.map((p, i) => (
                <button
                  key={p}
                  onClick={() => ui.set({ selection: { kind: "commit", hash: p } })}
                  className={cn("rounded-xs px-0.5 font-mono hover:bg-accent hover:text-foreground", i === 0 && c.parents.length > 1 && "text-muted-foreground")}
                >
                  {shortHash(p)}
                </button>
              ))}
            </span>
            <RefPills labels={overview.data?.refs[c.hash] ?? []} trunk={trunk} max={6} />
          </div>
          {c.body && showBody && <p className="mt-1.5 whitespace-pre-wrap text-small text-muted-foreground [overflow-wrap:anywhere]">{c.body}</p>}
        </>
      )}
    </div>
  )
}
