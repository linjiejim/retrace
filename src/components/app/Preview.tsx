import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { formatBytes } from "@/lib/format"
import { isMarkdown, isSvg } from "@/lib/filetype"
import { prefs, ui, useStore } from "@/lib/store"
import type { FileChange, FileContent, Target } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useFileContent } from "@/hooks/queries"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"
import { Skeleton } from "@/components/ui/skeleton"
import { StateView } from "@/components/ui/state"

const TextPreview = lazy(() => import("./DiffViews").then((m) => ({ default: m.TextPreview })))
const Markdown = lazy(() => import("./Markdown"))

function Loading() {
  const shown = useDelayedFlag(true)
  if (!shown) return null
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-3" />
      ))}
    </div>
  )
}

const dataUrl = (c: FileContent) => `data:${c.mime};base64,${c.data}`

/** A file of the selected version: highlighted text, an image, or rendered Markdown. */
export function FilePreview({ projectId, target, path }: { projectId: string; target: Target; path: string }) {
  const content = useFileContent(projectId, target, path)
  const rendered = useStore(prefs, (s) => s.rendered)
  if (content.isError) return <StateView size="sm" kind="error" description={content.error.message} onRetry={() => content.refetch()} />
  if (content.data === undefined) return <Loading />
  const c = content.data
  if (!c) return <StateView size="sm" kind="empty" title="这个版本里没有这个文件" description="换一个提交，或在左边选别的文件。" />
  if (c.tooLarge) return <StateView size="sm" kind="empty" title="文件太大" description={`${formatBytes(c.size)}，超过预览上限。`} />
  if (c.data && c.mime && (!isSvg(path) || rendered || c.text == null)) return <ImageView src={dataUrl(c)} size={c.size} />
  if (c.text == null) return <StateView size="sm" kind="empty" title="二进制文件" description={`${formatBytes(c.size)}，不能预览。`} />
  return (
    <Suspense fallback={<Loading />}>
      {isMarkdown(path) && rendered ? <Markdown text={c.text} path={path} projectId={projectId} target={target} /> : <TextPreview name={path} text={c.text} />}
    </Suspense>
  )
}

function ImageView({ src, size, label, className }: { src: string; size: number; label?: string; className?: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const tiny = !!dims && dims.w <= 64 && dims.h <= 64
  return (
    <figure className={cn("flex h-full min-h-0 min-w-0 flex-col gap-2 p-4", className)}>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          // Icons are shown at least 128px wide, without blurring.
          className={cn("bg-checker max-h-full max-w-full rounded-xs object-contain ring-1 ring-border", tiny && "min-w-32 [image-rendering:pixelated]")}
        />
      </div>
      <figcaption className="shrink-0 text-center text-caption tabular text-faint-foreground">
        {label && <span className="mr-2 font-medium text-muted-foreground">{label}</span>}
        {dims && `${dims.w} × ${dims.h} · `}
        {formatBytes(size)}
      </figcaption>
    </figure>
  )
}

/** A changed image: before and after, side by side or stacked like the diff. */
export function ImageCompare({ projectId, target, change }: { projectId: string; target: Target; change: FileChange }) {
  const old = useFileContent(projectId, target, change.path, "old", change.oldPath)
  const neu = useFileContent(projectId, target, change.path, "new")
  const diffStyle = useStore(prefs, (s) => s.diffStyle)
  const failed = old.error ?? neu.error
  if (failed) return <StateView size="sm" kind="error" description={failed.message} onRetry={() => (old.refetch(), neu.refetch())} />
  if (old.data === undefined || neu.data === undefined) return <Loading />
  const sides = [
    { label: "改前", c: old.data },
    { label: "改后", c: neu.data },
  ].filter((s): s is { label: string; c: FileContent } => !!s.c)
  if (sides.some((s) => s.c.tooLarge)) return <StateView size="sm" kind="empty" title="图片太大" description="超过 8 MB 的图片不预览。" />
  if (sides.length === 0 || sides.some((s) => !s.c.data)) return <StateView size="sm" kind="empty" title="二进制文件" description="这个文件不能预览。" />
  return (
    <div className={cn("grid h-full min-h-0", sides.length === 2 && (diffStyle === "split" ? "grid-cols-2 divide-x" : "grid-rows-2 divide-y"))}>
      {sides.map((s) => (
        <ImageView key={s.label} src={dataUrl(s.c)} size={s.c.size} label={sides.length === 2 ? s.label : s.label === "改前" ? "已删除" : "新增"} className="min-h-0" />
      ))}
    </div>
  )
}

/** Changed images for continuous reading, where the patch only says "binary": shown above the text diffs. */
export function ImageStrip({ projectId, target, images }: { projectId: string; target: Target; images: FileChange[] }) {
  const jump = useStore(ui, (s) => s.jump)
  const root = useRef<HTMLDivElement>(null)
  // A picked image scrolls into view; also on mount, since the strip can appear after the pick
  // (the diff view mounts its header once the patch has loaded).
  useEffect(() => {
    const path = ui.get().file?.path
    if (path && images.some((f) => f.path === path)) root.current?.querySelector(`[data-image="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" })
  }, [jump, images])
  return (
    <div ref={root} className="border-b">
      {images.map((c) => (
        <section key={c.path} data-image={c.path} className="border-b last:border-b-0">
          <div className="flex h-8 items-center px-3 font-mono text-caption text-muted-foreground">
            <span className="min-w-0 truncate">{c.path}</span>
          </div>
          <div className="h-[240px]">
            <ImageCompare projectId={projectId} target={target} change={c} />
          </div>
        </section>
      ))}
    </div>
  )
}
