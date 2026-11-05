import { describe, expect, it } from "vitest"
import { isImage, isMarkdown, resolvePath } from "./filetype"

describe("filetype", () => {
  it("knows images and Markdown by extension", () => {
    expect(isImage("assets/Logo.PNG")).toBe(true)
    expect(isImage("README.md")).toBe(false)
    expect(isMarkdown("docs/a.markdown")).toBe(true)
  })

  it("resolves links in a Markdown file against its folder", () => {
    expect(resolvePath("docs/specs/a.md", "b.md")).toBe("docs/specs/b.md")
    expect(resolvePath("docs/specs/a.md", "../README.md#usage")).toBe("docs/README.md")
    expect(resolvePath("docs/a.md", "/src/main.ts")).toBe("src/main.ts")
    expect(resolvePath("docs/a.md", "./img/a%20b.png")).toBe("docs/img/a b.png")
    expect(resolvePath("a.md", "../../etc/passwd")).toBeNull()
    expect(resolvePath("a.md", "#section")).toBeNull()
  })
})
