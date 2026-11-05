// Loaded lazily (see DiffPanel): everything that pulls in @pierre/diffs and Shiki.
import { useEffect, useMemo, useRef, type ReactNode } from "react"
import { CodeView, File as CodeFile, MultiFileDiff, WorkerPoolContext, type CodeViewHandle } from "@pierre/diffs/react"
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker"
import { parsePatchFiles, type CodeViewDiffItem } from "@pierre/diffs"
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import { useAppearance } from "@/lib/appearance"
import { prefs, ui, useStore } from "@/lib/store"
import type { FileChange, Target } from "@/lib/types"
import { useFilePair, usePatch } from "@/hooks/queries"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"
import { isImage, isSvg } from "@/lib/filetype"
import { t } from "@/lib/i18n"
import { ImageStrip } from "./Preview"
import { Skeleton } from "@/components/ui/skeleton"
import { StateView } from "@/components/ui/state"

// Inside the diff's shadow root: the app's surfaces and type, so it reads as one window.
const DIFF_CSS = `
:host { --diffs-font-family: var(--font-mono); --diffs-header-font-family: var(--font-sans); --diffs-font-size: 12px; --diffs-line-height: 20px; }
[data-diffs], pre { --diffs-bg: var(--background) !important; }
`

const THEMES = { light: "pierre-light", dark: "pierre-dark" } as const

/**
 * Syntax highlighting runs in workers so a big file never freezes scrolling. The pool outlives the
 * diff area: closing and reopening it (a click on the selected row) doesn't restart the workers.
 */
export function Pool({ children }: { children: ReactNode }) {
  const pool = getOrCreateWorkerPoolSingleton({ poolOptions: { workerFactory: () => new DiffsWorker(), poolSize: 3 }, highlighterOptions: { theme: THEMES } })
  return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>
}

function useDiffOptions() {
  const diffStyle = useStore(prefs, (s) => s.diffStyle)
  const wrap = useStore(prefs, (s) => s.wrap)
  const { resolved } = useAppearance()
  return useMemo(
    () => ({
      theme: THEMES,
      diffStyle,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      themeType: resolved,
      lineDiffType: "word-alt" as const,
      hunkSeparators: "line-info" as const,
      unsafeCSS: DIFF_CSS,
    }),
    [diffStyle, wrap, resolved],
  )
}

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

export function SingleDiff({ projectId, target, change }: { projectId: string; target: Target; change: FileChange | undefined }) {
  // Only once the file is known to belong to this target, and with this target's rename source.
  const pair = useFilePair(projectId, target, change ? { path: change.path, oldPath: change.oldPath } : null)
  const options = useDiffOptions()
  if (!change) return null
  if (pair.isError) return <StateView size="sm" kind="error" description={pair.error.message} onRetry={() => pair.refetch()} />
  if (!pair.data) return <Loading />
  const { old, new: neu } = pair.data
  if (old?.binary || neu?.binary) return <StateView size="sm" kind="empty" title={t("Binary file")} description={t("Binary files have no diff.")} />
  if (old?.tooLarge || neu?.tooLarge) return <StateView size="sm" kind="empty" title={t("File too large")} description={t("Files over 2 MB have no diff.")} />
  return (
    <div className="h-full overflow-auto">
      <MultiFileDiff
        key={`${change.path}:${options.diffStyle}`}
        oldFile={{ name: change.oldPath ?? change.path, contents: old?.text ?? "" }}
        newFile={{ name: change.path, contents: neu?.text ?? "" }}
        options={{ ...options, disableFileHeader: true }}
      />
    </div>
  )
}

/** Every changed file stacked, from one patch; picking a file scrolls to it, scrolling marks the file. */
export function ContinuousDiff({ projectId, target, files }: { projectId: string; target: Target; files: FileChange[] }) {
  const patch = usePatch(projectId, target, true)
  const options = useDiffOptions()
  const view = useRef<CodeViewHandle<undefined, undefined>>(null)
  const jump = useStore(ui, (s) => s.jump)
  const order = useStore(ui, (s) => s.fileOrder)
  // The patch only says "binary" for images: they get their own before/after strip at the top.
  const images = useMemo(() => files.filter((f) => isImage(f.path) && !isSvg(f.path)), [files])
  const items = useMemo((): CodeViewDiffItem[] => {
    if (!patch.data?.patch) return []
    const skip = new Set(images.map((f) => f.path))
    const parsed = parsePatchFiles(patch.data.patch).flatMap((p) => p.files)
    // Follow the changes list's order so ↑↓ and scrolling agree.
    const rank = new Map(order.map((p, i) => [p, i]))
    return parsed
      .filter((fileDiff) => !skip.has(fileDiff.name))
      .map((fileDiff) => ({ id: fileDiff.name, type: "diff" as const, fileDiff }))
      .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
  }, [patch.data, order, images])

  // A file picked in the list (or with ↑↓) scrolls here; scrolling here doesn't bump `jump`.
  useEffect(() => {
    const path = ui.get().file?.path
    // Images sit in the strip above the diffs, which scrolls to them itself.
    if (path && items.some((i) => i.id === path)) view.current?.scrollTo({ type: "item", id: path, align: "start" })
  }, [jump, items])

  const spy = useRef(0)
  const onScroll = (top: number) => {
    cancelAnimationFrame(spy.current)
    spy.current = requestAnimationFrame(() => {
      const inst = view.current?.getInstance()
      if (!inst) return
      let current: string | null = null
      for (const it of items) {
        const t = inst.getTopForItem(it.id)
        if (t == null || t > top + 8) break
        current = it.id
      }
      if (current && current !== ui.get().file?.path) {
        const change = files.find((f) => f.path === current)
        ui.set({ file: { path: current, oldPath: change?.oldPath ?? null } })
      }
    })
  }

  if (patch.isError) return <StateView size="sm" kind="error" description={patch.error.message} onRetry={() => patch.refetch()} />
  if (!patch.data) return <Loading />
  const banner = patch.data.truncated && (
    <div className="border-b bg-warning-subtle px-3 py-1.5 text-caption text-warning">{t("The change is too large: only the first 8 MB are shown. See the other files one at a time.")}</div>
  )
  const strip = images.length > 0 && <ImageStrip projectId={projectId} target={target} images={images} />
  if (items.length === 0 && strip)
    return (
      <div className="h-full overflow-y-auto">
        {banner}
        {strip}
      </div>
    )
  if (items.length === 0)
    return patch.data.truncated ? (
      <StateView size="sm" kind="empty" title={t("Change too large")} description={t("A single file is over 8 MB, so it can't be read continuously.")} />
    ) : (
      <StateView size="sm" kind="empty" title={t("No text changes to show")} />
    )
  return (
    <CodeView
      ref={view}
      items={items}
      className="h-full overflow-y-auto overflow-x-hidden"
      options={{ ...options, stickyHeaders: true }}
      onScroll={onScroll}
      renderCodeViewHeader={() => (
        <>
          {banner}
          {strip}
        </>
      )}
    />
  )
}

/** One file with highlighting, for the files view. */
export function TextPreview({ name, text }: { name: string; text: string }) {
  const { theme, themeType, overflow, unsafeCSS } = useDiffOptions()
  return (
    <div className="h-full overflow-auto">
      <CodeFile key={name} file={{ name, contents: text }} options={{ theme, themeType, overflow, unsafeCSS, disableFileHeader: true }} />
    </div>
  )
}
