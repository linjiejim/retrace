import { describe, expect, it } from "vitest"
import { prNumber } from "./github"

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
