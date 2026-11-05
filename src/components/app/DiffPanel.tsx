import { lazy, Suspense, useEffect, useState } from "react"
import { ChevronDown, ChevronUp, Columns2, Copy, FileText, Files, GitCompareArrows, Maximize2, Minimize2, Rows2, WrapText, X } from "lucide-react"
import { copyText } from "@/lib/api"
import { closeDiff, openFile } from "@/lib/commands"
import { isImage, isMarkdown, isSvg } from "@/lib/filetype"
import { absoluteTime, shortHash } from "@/lib/format"
import { keyNav } from "@/lib/keys"
import { prefs, ui, useStore } from "@/lib/store"
import { STATUS_LETTER } from "@/lib/tree"
import type { FileChange, Target, Trunk } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useChanges, useCommit, useOverview } from "@/hooks/queries"
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
  const info = projectId && selection?.kind === "commit" ? <CommitInfo projectId={projectId} hash={selection.hash} trunk={trunk} /> : null

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
      <IconButton label="上一个文件  ↑" size="icon-sm" disabled={index <= 0} onClick={() => keyNav.changes?.(-1)}>
        <ChevronUp />
      </IconButton>
      <IconButton label="下一个文件  ↓" size="icon-sm" disabled={order.length === 0 || index >= order.length - 1} onClick={() => keyNav.changes?.(1)}>
        <ChevronDown />
      </IconButton>
    </>
  )
}

function CloseButton() {
  const focusMode = useStore(ui, (s) => s.focusMode)
  return (
    <>
      <IconButton
        label={focusMode ? "退出专注  F" : "专注：只看改动和 diff  F"}
        size="icon-sm"
        className={cn("@max-[400px]/header:hidden", focusMode && "bg-pressed")}
        onClick={() => ui.set({ focusMode: !focusMode, diffOpen: true })}
      >
        {focusMode ? <Minimize2 /> : <Maximize2 />}
      </IconButton>
      <IconButton label="关闭  Esc" size="icon-sm" onClick={closeDiff}>
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
        {file ? <PathLabel path={file.path} from={change?.oldPath} /> : <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">{diffView === "all" && files.length ? `全部 ${files.length} 个文件` : "diff"}</span>}
        <StepButtons />
        <span className="@max-[560px]/header:hidden">
          <Segmented
            size="sm"
            aria-label="阅读方式"
            value={diffView}
            onValueChange={(v) => prefs.set({ diffView: v })}
            options={[
              { value: "file", label: <span className="sr-only">单个文件</span>, icon: <FileText /> },
              { value: "all", label: <span className="sr-only">连续阅读全部文件</span>, icon: <Files /> },
            ]}
          />
        </span>
        <span className="@max-[460px]/header:hidden">
          <Segmented
            size="sm"
            aria-label="diff 布局"
            value={diffStyle}
            onValueChange={(v) => prefs.set({ diffStyle: v })}
            options={[
              { value: "split", label: <span className="sr-only">并排</span>, icon: <Columns2 /> },
              { value: "unified", label: <span className="sr-only">合并</span>, icon: <Rows2 /> },
            ]}
          />
        </span>
        <IconButton label={wrap ? "不换行" : "自动换行"} size="icon-sm" className={cn("@max-[520px]/header:hidden", wrap && "bg-pressed")} onClick={() => prefs.set({ wrap: !wrap })}>
          <WrapText />
        </IconButton>
        <CloseButton />
      </PanelHeader>
      {info}
      <div className="selectable relative min-h-0 flex-1 overflow-hidden">
        {!projectId || !target ? (
          <Hint>选一个提交或未提交的改动</Hint>
        ) : (
          <Suspense fallback={null}>
            <Pool>
              {diffView === "all" ? (
                <ContinuousDiff projectId={projectId} target={target} files={files} />
              ) : !change ? (
                loaded && <Hint>{files.length ? "在改动里选一个文件" : "没有文件改动"}</Hint>
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
        {path ? <PathLabel path={path} /> : <span className="min-w-0 flex-1 truncate text-caption text-faint-foreground">预览</span>}
        {change && (
          <Tooltip content="这个文件在选中的版本里有改动：切回改动，看它的 diff">
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
              看改动
            </Button>
          </Tooltip>
        )}
        {renderable && (
          <Segmented
            size="sm"
            aria-label="预览方式"
            value={rendered ? "rendered" : "source"}
            onValueChange={(v) => prefs.set({ rendered: v === "rendered" })}
            options={[
              { value: "rendered", label: "渲染" },
              { value: "source", label: "源码" },
            ]}
          />
        )}
        <StepButtons />
        <CloseButton />
      </PanelHeader>
      {info}
      <div className="selectable relative min-h-0 flex-1 overflow-hidden">
        {!projectId || !target ? (
          <Hint>选一个提交或未提交的改动</Hint>
        ) : !path ? (
          <Hint>在左边的文件里选一个预览</Hint>
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
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [hash])
  const c = commit.data
  const long = !!c && (c.body.split("\n").length > 3 || c.body.length > 240)

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
          <h2 className="text-body font-semibold [overflow-wrap:anywhere]">{c.subject}</h2>
          <div className="flex flex-wrap items-center gap-x-1.5 text-caption text-faint-foreground">
            <Tooltip content="复制完整 hash">
              <button
                onClick={() => copyText(c.hash).then(() => notify.success(`已复制 ${shortHash(c.hash)}`))}
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
            {c.committer !== c.author && <span>· 由 {c.committer} 提交</span>}
            <span>·</span>
            <span>
              {c.parents.length > 1 ? "合并提交，对比第一个父提交 " : c.parents.length ? "父提交 " : "根提交"}
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
          {c.body && (
            <>
              <p className={cn("mt-1 whitespace-pre-wrap text-small text-muted-foreground [overflow-wrap:anywhere]", !expanded && "line-clamp-3")}>{c.body}</p>
              {long && (
                <button onClick={() => setExpanded((x) => !x)} className="mt-0.5 text-caption text-primary hover:underline">
                  {expanded ? "收起说明" : "展开说明"}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
