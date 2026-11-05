/**
 * The pull request a commit came from: a squash merge ends its subject with "(#N)", a merge
 * commit starts with "Merge pull request #N from …".
 */
export function prNumber(subject: string): number | null {
  const m = subject.match(/^Merge pull request #(\d+)\b/) ?? subject.match(/\(#(\d+)\)\s*$/)
  return m ? Number(m[1]) : null
}

export const prUrl = (webUrl: string, n: number) => `${webUrl}/pull/${n}`
