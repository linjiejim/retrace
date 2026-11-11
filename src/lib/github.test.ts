import { describe, expect, it } from "vitest"
import { arrange, checkTally, discussionCount, hunkTail, prNumber, prOfBranch, sortChecks } from "./github"
import type { Check, CheckState, PrDiscussion, PrPost, PrThread, PullRequest } from "./types"

describe("prNumber", () => {
  it("reads squash and merge commit subjects", () => {
    expect(prNumber("feat(mobile): kit 收敛二期 (#287)")).toBe(287)
    expect(prNumber("Merge pull request #12 from jim/feat-x")).toBe(12)
  })

  it("ignores issue mentions elsewhere in the subject", () => {
    expect(prNumber("fix: closes #45 in the parser")).toBeNull()
    expect(prNumber("chore: release 0.3.0")).toBeNull()
  })
})

describe("checkTally", () => {
  const check = (state: CheckState): Check => ({ name: state, workflow: null, state, url: null, startedAt: null, completedAt: null })

  it("counts cancelled as failed and leaves skipped and neutral out", () => {
    const states: CheckState[] = ["success", "success", "failure", "cancelled", "pending", "skipped", "neutral"]
    expect(checkTally(states.map(check))).toEqual({ passed: 2, failed: 2, pending: 1 })
    expect(checkTally([])).toEqual({ passed: 0, failed: 0, pending: 0 })
  })
})

describe("checks", () => {
  const check = (name: string, state: CheckState): Check => ({ name, workflow: null, state, url: null, startedAt: null, completedAt: null })

  it("puts failures first, then running ones, each by workflow and name as the rows read", () => {
    const sorted = sortChecks([check("b", "success"), check("a", "skipped"), check("z", "pending"), check("y", "failure"), check("a", "success")])
    expect(sorted.map((c) => `${c.state}:${c.name}`)).toEqual(["failure:y", "pending:z", "success:a", "success:b", "skipped:a"])
    const flows = sortChecks([{ ...check("a", "success"), workflow: "Lint" }, { ...check("b", "success"), workflow: "CI" }, { ...check("c", "success"), workflow: "CI" }])
    expect(flows.map((c) => `${c.workflow} / ${c.name}`)).toEqual(["CI / b", "CI / c", "Lint / a"])
  })
})

describe("prOfBranch", () => {
  const pr = (number: number, headRefName: string, isCrossRepository = false) => ({ number, headRefName, isCrossRepository }) as PullRequest

  it("finds our branch's pull request, never a fork's of the same name", () => {
    const items = [pr(1, "feat/x", true), pr(2, "feat/x"), pr(3, "feat/y")]
    expect(prOfBranch(items, "feat/x")?.number).toBe(2)
    expect(prOfBranch([pr(1, "feat/x", true)], "feat/x")).toBeUndefined()
    expect(prOfBranch(items, "feat/z")).toBeUndefined()
    expect(prOfBranch(items, null)).toBeUndefined()
    expect(prOfBranch(undefined, "feat/x")).toBeUndefined()
  })
})

describe("discussion", () => {
  const post = (p: Partial<PrPost>): PrPost => ({ kind: "comment", id: null, author: "a", body: "hi", state: null, at: 1, url: "", ...p })
  const thread = (reviewId: string | null, replies = 1): PrThread => ({
    path: "a.ts", line: 3, startLine: null, originalLine: 3, oldSide: false, resolved: false, outdated: false, reviewId, diffHunk: "",
    comments: Array.from({ length: replies }, () => ({ author: "b", body: "x", at: 2, url: "" })),
  })
  const d: PrDiscussion = {
    posts: [
      post({}),
      post({ kind: "review", id: "R1", body: "", state: "commented" }),
      post({ kind: "review", id: "R2", body: "", state: "commented" }),
      post({ kind: "review", id: "R3", body: "", state: "approved" }),
    ],
    threads: [thread("R1", 2), thread("R9")],
    truncated: false,
  }

  it("puts threads under their review and drops reviews with nothing to show", () => {
    const { posts, loose } = arrange(d)
    expect(posts.map((p) => p.post.id)).toEqual([null, "R1", "R3"])
    expect(posts[1].threads).toHaveLength(1)
    expect(loose).toHaveLength(1)
  })

  it("counts comments, reviews that say something, and every line comment", () => {
    expect(discussionCount(d)).toBe(1 + 3)
  })

  it("keeps the end of the hunk, without its header", () => {
    expect(hunkTail("@@ -1,5 +1,5 @@\n a\n b\n-c\n+d\n e", 3)).toEqual(["-c", "+d", " e"])
  })
})
