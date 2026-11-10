import { describe, expect, it } from "vitest"
import { checkTally, prNumber } from "./github"
import type { Check, CheckState } from "./types"

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
