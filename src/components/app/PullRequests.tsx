import { lazy, Suspense, useState } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import { Check as CheckMark, ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, FolderGit2, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, RefreshCw, Search } from "lucide-react"
import { openLink } from "@/lib/commands"
import { checkTally, sortChecks } from "@/lib/github"
import { absoluteTime, ago, duration, tildify } from "@/lib/format"
import { prefs, useStore } from "@/lib/store"
import type { Check, CheckState, PullRequest, PullRequests, Target, Worktree } from "@/lib/types"
import { t, tp } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip } from "@/components/ui/tooltip"
import { useBranchPr } from "@/hooks/queries"
import { useDelayedFlag } from "@/hooks/use-delayed-flag"

import { DiscussionButton } from "./PrDiscussion"

const Markdown = lazy(() => import("./Markdown"))

// ---------- small parts ----------

function tallyText(checks: Check[]) {
  const { failed, pending, passed } = checkTally(checks)
  return t("Checks: {passed} passed, {failed} failed, {pending} running", { passed, failed, pending })
}

/** One icon for the whole run: any failure, else anything still running, else passed. */
function ChecksIcon({ checks, className }: { checks: Check[]; className?: string }) {
  if (checks.length === 0) return null
  const { failed, pending } = checkTally(checks)
  const Icon = failed ? CircleX : pending ? CircleDashed : CircleCheck
  return <Icon aria-label={tallyText(checks)} className={cn("size-3.5 shrink-0", failed ? "text-destructive" : pending ? "text-warning" : "text-success", className)} />
}

const STATE_ICON: Record<CheckState, { icon: typeof CircleCheck; tone: string }> = {
  success: { icon: CircleCheck, tone: "text-success" },
  failure: { icon: CircleX, tone: "text-destructive" },
  cancelled: { icon: CircleX, tone: "text-faint-foreground" },
  pending: { icon: CircleDashed, tone: "text-warning" },
  skipped: { icon: CircleMinus, tone: "text-faint-foreground" },
  neutral: { icon: CircleMinus, tone: "text-faint-foreground" },
}

/** Read at render time, so the language in use applies. */
const stateLabel = (state: CheckState) =>
  ({ success: t("Passed"), failure: t("Failed"), cancelled: t("Cancelled"), pending: t("Running"), skipped: t("Skipped"), neutral: t("Neutral") })[state]

/** The checks' summary; opens the list of every check, each linking to its page. */
export function ChecksSummary({ checks }: { checks: Check[] }) {
  const { failed, pending } = checkTally(checks)
  return (
    <Popover>
      <Tooltip content={tallyText(checks)}>
        <PopoverTrigger asChild>
          <button className={cn("-mx-0.5 inline-flex items-center gap-1 rounded-xs px-0.5 hover:bg-accent", failed ? "text-destructive" : pending ? "text-warning" : "text-success")}>
            <ChecksIcon checks={checks} />
            {failed ? tp("{n} check failed", "{n} checks failed", failed) : pending ? tp("{n} check running", "{n} checks running", pending) : t("Checks passed")}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="w-[380px] p-1" align="start">
        <div className="px-2 pb-1 pt-1.5 text-caption text-faint-foreground">{tallyText(checks)}</div>
        <ul className="max-h-[50vh] overflow-y-auto">
          {sortChecks(checks).map((c) => {
            const s = STATE_ICON[c.state]
            const took = c.startedAt && c.completedAt ? duration(c.completedAt - c.startedAt) : null
            return (
              <li key={`${c.workflow ?? ""}/${c.name}`}>
                <button
                  disabled={!c.url}
                  onClick={() => c.url && openLink(c.url)}
                  className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-body enabled:hover:bg-accent"
                >
                  <s.icon aria-label={stateLabel(c.state)} className={cn("size-4 shrink-0", s.tone)} />
                  <span className="min-w-0 flex-1 truncate">
                    {c.workflow && <span className="text-faint-foreground">{c.workflow} / </span>}
                    {c.name}
                  </span>
                  {took && <span className="shrink-0 text-caption tabular text-faint-foreground">{took}</span>}
                  {c.url && <ExternalLink className="size-3.5 shrink-0 text-faint-foreground" />}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** `#N` on a worktree or branch whose branch has an open pull request. Not a control: it sits inside tab buttons. */
export function BranchPrBadge({ projectId, branch }: { projectId: string | null; branch: string | null | undefined }) {
  const pr = useBranchPr(projectId, branch)
  if (!pr) return null
  return (
    <span role="img" className="inline-flex shrink-0 items-center gap-0.5 font-mono text-faint-foreground" aria-label={t("PR #{n}: {title}", { n: pr.number, title: pr.title })}>
      <PrStateIcon pr={pr} className="size-3" />#{pr.number}
    </span>
  )
}

export function PrStateIcon({ pr, className }: { pr: PullRequest; className?: string }) {
  const c = cn("size-4 shrink-0", className)
  if (pr.state === "merged") return <GitMerge className={cn(c, "text-primary")} />
  if (pr.state === "closed") return <GitPullRequestClosed className={cn(c, "text-destructive")} />
  if (pr.isDraft) return <GitPullRequestDraft className={cn(c, "text-faint-foreground")} />
  return <GitPullRequest className={cn(c, "text-success")} />
}

function PrStateBadge({ pr }: { pr: PullRequest }) {
  if (pr.state === "merged") return <Badge tone="info">{t("Merged")}</Badge>
  if (pr.state === "closed") return <Badge tone="danger">{t("Closed")}</Badge>
  if (pr.isDraft) return <Badge tone="neutral">{t("Draft")}</Badge>
  return <Badge tone="success">{t("Open")}</Badge>
}

function Review({ pr }: { pr: PullRequest }) {
  if (pr.reviewDecision === "approved") return <span className="text-success">{t("Approved")}</span>
  if (pr.reviewDecision === "changesRequested") return <span className="text-warning">{t("Changes requested")}</span>
  if (pr.reviewDecision === "reviewRequired") return <span>{t("Review required")}</span>
  return null
}

/** `owner:branch` for a fork's branch, the branch alone for ours. */
const headLabel = (pr: PullRequest) => (pr.isCrossRepository && pr.headOwner ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName)

function Stat({ pr }: { pr: PullRequest }) {
  return (
    <span className="tabular" aria-label={t("{a} lines added, {d} removed", { a: pr.additions, d: pr.deletions })}>
      <span className="text-success">+{pr.additions}</span> <span className="text-destructive">−{pr.deletions}</span>
    </span>
  )
}

// ---------- the PR menu ----------

/** The open pull requests, from the user's `gh`. `children` is the trigger. */
export function PrMenu({
  pulls,
  webUrl,
  trees,
  current,
  onOpen,
  children,
}: {
  pulls: UseQueryResult<PullRequests>
  webUrl: string
  /** To mark pull requests whose branch is checked out here. */
  trees: Worktree[]
  current: number | null
  onOpen: (n: number) => void
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const data = pulls.data
  const items = data?.state === "ok" ? data.items : []
  const query = q.trim().toLowerCase()
  const list = query ? items.filter((p) => `#${p.number} ${p.title} ${p.headRefName} ${p.author}`.toLowerCase().includes(query)) : items

  const retry = (
    <Button size="sm" variant="secondary" className="mt-2" onClick={() => pulls.refetch()} loading={pulls.isFetching}>
      <RefreshCw />
      {t("Try again")}
    </Button>
  )
  const note = (text: React.ReactNode, extra?: React.ReactNode) => (
    <div className="px-3 py-3 text-small text-muted-foreground">
      {text}
      {extra}
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && pulls.isStale && !pulls.isFetching) void pulls.refetch()
        if (!o) setQ("")
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[440px] p-0" align="start">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-caption text-faint-foreground">
          <span className="min-w-0 flex-1">{t("Open pull requests on GitHub")}</span>
          {pulls.isFetching && data && <Spinner className="size-3.5" label={t("Refreshing")} />}
        </div>
        {items.length > 8 && (
          <label className="mx-2 mb-1 flex h-7 items-center gap-1.5 rounded-sm px-2 text-faint-foreground ring-1 ring-border focus-within:ring-ring">
            <Search className="size-3.5" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Filter by title, number, branch or author")} className="w-full bg-transparent text-small text-foreground outline-none" />
          </label>
        )}
        {!data ? (
          pulls.isError ? (
            note(pulls.error.message, retry)
          ) : (
            <div className="space-y-2 px-3 py-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          )
        ) : data.state === "noGh" ? (
          note(
            <>
              {t("Install the GitHub CLI to see pull requests here:")}
              <code className="mt-1.5 block w-fit rounded-xs bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground">brew install gh</code>
            </>,
            retry,
          )
        ) : data.state === "noAuth" ? (
          note(
            <>
              {t("Log in to the GitHub CLI in a terminal, then try again:")}
              <code className="mt-1.5 block w-fit rounded-xs bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground">gh auth login</code>
            </>,
            retry,
          )
        ) : data.state !== "ok" ? (
          note(<span className="text-destructive">{data.message ?? t("Couldn't read the pull requests")}</span>, retry)
        ) : items.length === 0 ? (
          note(t("No open pull requests"))
        ) : list.length === 0 ? (
          note(t("No matching pull requests"))
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto px-1 pb-1">
            {list.map((pr) => {
              const tree = pr.isCrossRepository ? undefined : trees.find((w) => w.branch === pr.headRefName)
              return (
              <li key={pr.number}>
                <button
                  onClick={() => {
                    onOpen(pr.number)
                    setOpen(false)
                  }}
                  className={cn("flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent", pr.number === current && "bg-selected hover:bg-selected")}
                >
                  <PrStateIcon pr={pr} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium">{pr.title}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-caption text-faint-foreground">
                      <span className="shrink-0 font-mono">#{pr.number}</span>
                      <span className="shrink-0">{pr.author}</span>
                      <span className="min-w-0 truncate font-mono">
                        {headLabel(pr)} → {pr.baseRefName}
                      </span>
                      {pr.updatedAt && <span className="shrink-0">{ago(pr.updatedAt)}</span>}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-caption">
                    {tree && (
                      <Tooltip content={t("Checked out in {path}", { path: tildify(tree.path) })}>
                        <FolderGit2 aria-label={t("Checked out in {path}", { path: tildify(tree.path) })} className="size-3.5 shrink-0 text-muted-foreground" />
                      </Tooltip>
                    )}
                    {pr.isDraft && <span className="text-faint-foreground">{t("Draft")}</span>}
                    {pr.reviewDecision === "approved" && <span className="text-success">{t("Approved")}</span>}
                    {pr.reviewDecision === "changesRequested" && <span className="text-warning">{t("Changes requested")}</span>}
                    <ChecksIcon checks={pr.checks} />
                    <Stat pr={pr} />
                  </span>
                  {pr.number === current && <CheckMark className="mt-0.5 size-4 shrink-0" />}
                </button>
              </li>
              )
            })}
          </ul>
        )}
        <div className="border-t p-1">
          <button
            onClick={() => {
              openLink(`${webUrl}/pulls`)
              setOpen(false)
            }}
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-small text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
            {t("See all on GitHub")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------- above the diff ----------

/** Above the diff of a pull request's whole change: what GitHub shows at the top of the PR. */
/** The PR card while the pull request or its commits are read: the same shape, filling the area. */
export function PrInfoSkeleton() {
  const show = useDelayedFlag(true)
  if (!show) return <div className="min-h-0 flex-1" />
  return (
    <div aria-busy aria-label={t("Loading the pull request")} className="min-h-0 flex-1 space-y-2 overflow-hidden px-3 py-2">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-3 w-1/3" />
      <DescriptionSkeleton />
    </div>
  )
}

function DescriptionSkeleton() {
  const show = useDelayedFlag(true)
  if (!show) return null
  return (
    <div className="mt-2 space-y-2 border-t pt-3">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  )
}

/** `fill`: no file picked, the card takes the whole area and the description is always shown. */
export function PrInfo({ projectId, pr, target, fill }: { projectId: string; pr: PullRequest; target: Target | null; fill?: boolean }) {
  const showBody = useStore(prefs, (s) => s.commitBody) || !!fill
  const body = pr.body?.trim()
  const when = pr.state === "merged" ? pr.mergedAt : pr.state === "closed" ? pr.closedAt : pr.updatedAt
  const whenLabel = pr.state === "merged" ? t("Merged {time}", { time: when ? ago(when) : "" }) : pr.state === "closed" ? t("Closed {time}", { time: when ? ago(when) : "" }) : t("Updated {time}", { time: when ? ago(when) : "" })

  return (
    <div className={cn("selectable overflow-y-auto px-3 py-2", fill ? "min-h-0 flex-1" : "max-h-[40%] shrink-0 border-b")}>
      <div className="flex items-start gap-1">
        {body && !fill && (
          <Tooltip content={showBody ? t("Hide the description") : t("Show the description")}>
            <button
              aria-label={showBody ? t("Hide the description") : t("Show the description")}
              aria-expanded={showBody}
              onClick={() => prefs.set({ commitBody: !showBody })}
              className="-ml-1 mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-faint-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className={cn("size-3.5 transition-transform duration-(--duration-fast)", showBody && "rotate-90")} />
            </button>
          </Tooltip>
        )}
        <h2 className="min-w-0 flex-1 text-body font-semibold [overflow-wrap:anywhere]">
          {pr.title} <span className="font-normal text-faint-foreground">#{pr.number}</span>
        </h2>
        {target && <DiscussionButton projectId={projectId} pr={pr} target={target} />}
        <Tooltip content={t("Open PR #{n} in the browser", { n: pr.number })}>
          <Button size="sm" variant="ghost" className="-my-1 -mr-1.5 shrink-0" onClick={() => openLink(pr.url)}>
            <ExternalLink />
            GitHub
          </Button>
        </Tooltip>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-faint-foreground">
        <PrStateBadge pr={pr} />
        <span>{pr.author}</span>
        <span>·</span>
        <Tooltip content={t("Merges {head} into {base}", { head: headLabel(pr), base: pr.baseRefName })}>
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {pr.baseRefName} ← {headLabel(pr)}
          </span>
        </Tooltip>
        {when && (
          <>
            <span>·</span>
            <span title={absoluteTime(when)}>{whenLabel}</span>
          </>
        )}
        {pr.checks.length > 0 && (
          <>
            <span>·</span>
            <ChecksSummary checks={pr.checks} />
          </>
        )}
        {pr.reviewDecision && (
          <>
            <span>·</span>
            <Review pr={pr} />
          </>
        )}
        {pr.state === "open" && pr.mergeable === "conflicting" && (
          <>
            <span>·</span>
            <span className="text-warning">{t("Has conflicts")}</span>
          </>
        )}
        <span>·</span>
        <Stat pr={pr} />
        <span>{tp("{n} file", "{n} files", pr.changedFiles)}</span>
      </div>
      {/* Read from the list, the description isn't here yet: it comes with the PR's own read. */}
      {pr.body === null && <DescriptionSkeleton />}
      {body && showBody && target && (
        <div className="mt-2 border-t pt-2">
          <Suspense fallback={<Skeleton className="h-3 w-1/2" />}>
            <Markdown compact remoteImages text={body} path="" projectId={projectId} target={target} />
          </Suspense>
        </div>
      )}
    </div>
  )
}
