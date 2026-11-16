import { expect, it } from "vitest"
import { drafts } from "./drafts"

it("keeps each session's unsent text apart", () => {
  expect(drafts.get("a")).toBe("")
  drafts.set("a", "rename the helper")
  drafts.set("b", "add a test")
  expect(drafts.get("a")).toBe("rename the helper")
  expect(drafts.get("b")).toBe("add a test")
  drafts.set("a", "rename the helper\nand its callers")
  expect(drafts.get("a")).toBe("rename the helper\nand its callers")
})

it("forgets a draft once it is sent or emptied", () => {
  drafts.set("c", "fix the build")
  drafts.clear("c")
  expect(drafts.get("c")).toBe("")
  drafts.set("d", "x")
  drafts.set("d", "")
  expect(drafts.get("d")).toBe("")
})
