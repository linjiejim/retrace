import type { Check } from "./types"

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
