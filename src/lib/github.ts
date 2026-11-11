import type { Check, CheckState, PrDiscussion, PrPost, PrThread, PullRequest } from "./types"

/**
 * The pull request a commit came from: a squash merge ends its subject with "(#N)", a merge
 * commit starts with "Merge pull request #N from …".
 */
export function prNumber(subject: string): number | null {
  const m = subject.match(/^Merge pull request #(\d+)\b/) ?? subject.match(/\(#(\d+)\)\s*$/)
  return m ? Number(m[1]) : null
}

export const prUrl = (webUrl: string, n: number) => `${webUrl}/pull/${n}`

/** Cancelled counts as failed, as GitHub's own rollup does; skipped and neutral count as neither. */
export function checkTally(checks: Check[]) {
  let failed = 0
  let pending = 0
  let passed = 0
  for (const c of checks) {
    if (c.state === "failure" || c.state === "cancelled") failed++
    else if (c.state === "pending") pending++
    else if (c.state === "success") passed++
  }
  return { failed, pending, passed }
}

const ORDER: Record<CheckState, number> = { failure: 0, cancelled: 1, pending: 2, success: 3, neutral: 4, skipped: 5 }

/** What needs a look first: failures, then running, then the rest; by workflow, then name, within each. */
export function sortChecks(checks: Check[]): Check[] {
  return [...checks].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.workflow ?? "").localeCompare(b.workflow ?? "") || a.name.localeCompare(b.name))
}

/** The open pull request whose head is this branch. Forks don't count: their branch isn't ours even when the name matches. */
export function prOfBranch(items: PullRequest[] | undefined, branch: string | null | undefined): PullRequest | undefined {
  return branch ? items?.find((p) => !p.isCrossRepository && p.headRefName === branch) : undefined
}

/** What GitHub's Conversation tab counts: comments, reviews with something to say, line comments. */
export function discussionCount(d: PrDiscussion): number {
  return d.posts.filter((p) => p.kind === "comment" || p.body.trim()).length + d.threads.reduce((n, th) => n + th.comments.length, 0)
}

/** Threads under the review they were started in; the rest (a review that isn't shown) at the end. */
export function arrange(d: PrDiscussion): { posts: { post: PrPost; threads: PrThread[] }[]; loose: PrThread[] } {
  const ids = new Set(d.posts.map((p) => p.id).filter(Boolean))
  const posts = d.posts
    .map((post) => ({ post, threads: post.id ? d.threads.filter((th) => th.reviewId === post.id) : [] }))
    // A review that only says "commented" and carries no line comments has nothing to show.
    .filter(({ post, threads }) => post.kind === "comment" || post.body.trim() || threads.length > 0 || post.state !== "commented")
  return { posts, loose: d.threads.filter((th) => !th.reviewId || !ids.has(th.reviewId)) }
}

/** The last lines of the hunk, ending at the commented line (what GitHub shows above a thread). */
export function hunkTail(hunk: string, lines = 4): string[] {
  const all = hunk.split("\n").filter((l) => !l.startsWith("@@") && l !== "\\ No newline at end of file")
  return all.slice(-lines)
}
