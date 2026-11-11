import { lazy, Suspense, useState } from "react"
import { ChevronRight, CircleCheck, CircleDot, CircleSlash, ExternalLink, FileDiff, MessageSquare, RefreshCw } from "lucide-react"
import { openFile, openLink } from "@/lib/commands"
import { absoluteTime, ago } from "@/lib/format"
import { t } from "@/lib/i18n"
import { arrange, discussionCount, hunkTail } from "@/lib/github"
import type { PrPost, PrReply, PrThread, PullRequest, ReviewState, Target } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, IconButton } from "@/components/ui/button"
import { Drawer, DrawerBody, DrawerContent, DrawerHeader } from "@/components/ui/drawer"
import { Skeleton } from "@/components/ui/skeleton"
import { StateView } from "@/components/ui/state"
import { Tooltip } from "@/components/ui/tooltip"
import { usePrDiscussion } from "@/hooks/queries"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"

const Markdown = lazy(() => import("./Markdown"))

/** The button in the PR card: the count, and the drawer it opens. */
export function DiscussionButton({ projectId, pr, target }: { projectId: string; pr: PullRequest; target: Target }) {
  const [open, setOpen] = useState(false)
  const q = usePrDiscussion(projectId, pr.number)
  const count = q.data ? discussionCount(q.data) : null
  return (
    <>
      <Tooltip content={t("Comments and reviews")}>
        <Button size="sm" variant="ghost" className="-my-1 shrink-0" aria-label={t("Comments and reviews")} onClick={() => setOpen(true)}>
          <MessageSquare />
          {count !== null && <span className="tabular-nums">{count}</span>}
        </Button>
      </Tooltip>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent size="md">
          <DrawerHeader
            title={t("Discussion on PR #{n}", { n: pr.number })}
            description={pr.title}
            actions={
              <>
                <IconButton label={t("Refresh")} size="icon-sm" className="text-muted-foreground" disabled={q.isFetching} onClick={() => q.refetch()}>
                  <RefreshCw className={cn(q.isFetching && "animate-spin")} />
                </IconButton>
                <IconButton label={t("Open PR #{n} in the browser", { n: pr.number })} size="icon-sm" className="text-muted-foreground" onClick={() => openLink(pr.url)}>
                  <ExternalLink />
                </IconButton>
              </>
            }
          />
          <DrawerBody className="selectable">
            <DiscussionBody query={q} projectId={projectId} target={target} pr={pr} onFile={() => setOpen(false)} />
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  )
}

function DiscussionBody({
  query,
  projectId,
  target,
  pr,
  onFile,
}: {
  query: ReturnType<typeof usePrDiscussion>
  projectId: string
  target: Target
  pr: PullRequest
  onFile: () => void
}) {
  const slow = useDelayedFlag(query.isPending)
  if (query.isPending) {
    return slow ? (
      <div className="space-y-5" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    ) : null
  }
  if (query.isError) {
    return <StateView size="sm" kind="error" title={t("Couldn't read the discussion")} description={query.error instanceof Error ? query.error.message : String(query.error)} onRetry={() => query.refetch()} />
  }
  const { posts, loose } = arrange(query.data)
  if (posts.length === 0 && loose.length === 0) {
    return <StateView size="sm" kind="empty" icon={<MessageSquare />} title={t("No comments or reviews yet")} />
  }
  const md = (text: string) => (
    <Suspense fallback={<Skeleton className="h-3 w-1/2" />}>
      <Markdown compact remoteImages text={text} path="" projectId={projectId} target={target} />
    </Suspense>
  )
  return (
    <div className="space-y-5">
      {posts.map(({ post, threads }, i) => (
        <article key={post.id ?? `${post.url}-${i}`} className="space-y-2">
          <PostHeader post={post} />
          {post.body.trim() && <div className="text-body">{md(post.body)}</div>}
          {threads.map((th, j) => (
            <Thread key={j} thread={th} md={md} onFile={onFile} />
          ))}
        </article>
      ))}
      {loose.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-small font-medium text-muted-foreground">{t("Other line comments")}</h3>
          {loose.map((th, j) => (
            <Thread key={j} thread={th} md={md} onFile={onFile} />
          ))}
        </section>
      )}
      {query.data.truncated && (
        <p className="flex items-center gap-2 border-t pt-3 text-small text-muted-foreground">
          {t("There's more on GitHub.")}
          <Button size="sm" variant="ghost" onClick={() => openLink(pr.url)}>
            <ExternalLink />
            GitHub
          </Button>
        </p>
      )}
    </div>
  )
}

const REVIEW: Record<ReviewState, { label: string; icon: typeof CircleCheck; className: string }> = {
  get approved() {
    return { label: t("approved"), icon: CircleCheck, className: "text-success" }
  },
  get changesRequested() {
    return { label: t("requested changes"), icon: CircleDot, className: "text-warning" }
  },
  get commented() {
    return { label: t("reviewed"), icon: MessageSquare, className: "text-muted-foreground" }
  },
  get dismissed() {
    return { label: t("review dismissed"), icon: CircleSlash, className: "text-faint-foreground" }
  },
}

function When({ at }: { at: number | null }) {
  return at ? <span title={absoluteTime(at)}>{ago(at)}</span> : null
}

function PostHeader({ post }: { post: PrPost }) {
  const review = post.kind === "review" && post.state ? REVIEW[post.state] : null
  const Icon = review?.icon
  return (
    <div className="flex items-center gap-1.5 text-small">
      {Icon && <Icon className={cn("size-3.5 shrink-0", review.className)} aria-hidden />}
      <span className="font-medium">{post.author}</span>
      {review && <span className="text-muted-foreground">{review.label}</span>}
      <span className="text-faint-foreground">·</span>
      <span className="text-faint-foreground">
        <When at={post.at} />
      </span>
      <span className="flex-1" />
      {post.url && <LinkOut url={post.url} />}
    </div>
  )
}

function LinkOut({ url }: { url: string }) {
  return (
    <IconButton label={t("Open on GitHub")} size="icon-sm" className="-my-1 size-6 text-faint-foreground" onClick={() => openLink(url)}>
      <ExternalLink className="size-3.5" />
    </IconButton>
  )
}

function Thread({ thread, md, onFile }: { thread: PrThread; md: (text: string) => React.ReactNode; onFile: () => void }) {
  // Resolved ones start folded, as on GitHub.
  const [open, setOpen] = useState(!thread.resolved)
  const line = thread.line ?? thread.originalLine
  const range = thread.startLine && line && thread.startLine !== line ? `${thread.startLine}–${line}` : line ? String(line) : ""
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex h-8 items-center gap-1.5 bg-sunken px-2 text-small">
        <button
          aria-expanded={open}
          aria-label={open ? t("Fold") : t("Unfold")}
          onClick={() => setOpen(!open)}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-(--duration-fast)", open && "rotate-90")} />
        </button>
        <span className="min-w-0 truncate font-mono" title={thread.path}>
          {thread.path}
          {range && <span className="text-faint-foreground">:{range}</span>}
        </span>
        {thread.resolved && <Badge>{t("Resolved")}</Badge>}
        {thread.outdated && <Badge>{t("Outdated")}</Badge>}
        <span className="flex-1" />
        <Tooltip content={t("Show in the diff")}>
          <IconButton
            label={t("Show in the diff")}
            tooltip={false}
            size="icon-sm"
            className="-my-1 size-6 text-faint-foreground"
            onClick={() => {
              onFile()
              openFile({ path: thread.path, oldPath: null })
            }}
          >
            <FileDiff className="size-3.5" />
          </IconButton>
        </Tooltip>
      </div>
      {open && (
        <>
          {thread.diffHunk && (
            <pre className="overflow-x-auto border-y bg-background py-1 font-mono text-caption leading-5">
              {hunkTail(thread.diffHunk).map((l, i) => (
                <div
                  key={i}
                  className={cn("px-2", l.startsWith("+") && "bg-(--diff-addition)", l.startsWith("-") && "bg-(--diff-deletion)")}
                >
                  {l || " "}
                </div>
              ))}
            </pre>
          )}
          <div className="divide-y">
            {thread.comments.map((c, i) => (
              <Reply key={i} reply={c} md={md} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Reply({ reply, md }: { reply: PrReply; md: (text: string) => React.ReactNode }) {
  return (
    <div className="space-y-1 px-3 py-2">
      <div className="flex items-center gap-1.5 text-small">
        <span className="font-medium">{reply.author}</span>
        <span className="text-faint-foreground">·</span>
        <span className="text-faint-foreground">
          <When at={reply.at} />
        </span>
        <span className="flex-1" />
        {reply.url && <LinkOut url={reply.url} />}
      </div>
      {reply.body.trim() && <div className="text-body">{md(reply.body)}</div>}
    </div>
  )
}
