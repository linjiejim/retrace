import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { compareVersions } from "./changelog"
import { lang, setLang } from "./i18n"
import { s } from "./strings"
import { releases } from "./whats-new"

const initial = lang()
afterEach(() => {
  setLang(initial)
  vi.useRealTimers()
})

const inBoth = () => {
  setLang("en")
  const en = releases()
  setLang("zh")
  const zh = releases()
  return { en, zh }
}

describe("release notes", () => {
  it("follow the UI language", () => {
    const { en, zh } = inBoth()
    expect(en[0].groups[0].title).toMatch(/^(Heads-up|New|Improved|Fixed)$/)
    expect(zh[0].groups[0].title).toMatch(/^(注意|新增|改进|修复)$/)
  })

  it("say the same versions in both languages, newest first, in the same groups", () => {
    const { en, zh } = inBoth()
    expect(zh.map((r) => r.version)).toEqual(en.map((r) => r.version))
    expect(zh.map((r) => r.date)).toEqual(en.map((r) => r.date))
    const kinds = (r: (typeof en)[number]) => `${r.version}: ${r.groups.map((g) => g.kind).join(", ")}`
    expect(zh.map(kinds)).toEqual(en.map(kinds))
    for (let i = 1; i < en.length; i++) expect(compareVersions(en[i - 1].version, en[i].version)).toBe(1)
  })

  it("use only the template's groups, in its order", () => {
    const order = ["heads-up", "new", "improved", "fixed"]
    for (const r of inBoth().en) {
      const at = r.groups.map((g) => order.indexOf(g.kind))
      expect(at, r.version).not.toContain(-1)
      expect(at, r.version).toEqual([...at].sort((a, b) => a - b))
    }
  })

  it("cover the version being built", () => {
    const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"))
    const { en, zh } = inBoth()
    expect(en.find((r) => r.version === version)?.groups.length).toBeGreaterThan(0)
    expect(zh.find((r) => r.version === version)?.groups.length).toBeGreaterThan(0)
  })

  it("date a release by the month, with the year only when it isn't this one", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 23) })
    setLang("en")
    expect([s().releaseDate("2026-11-20"), s().releaseDate("2025-11-20")]).toEqual(["Nov 20", "Nov 20, 2025"])
    setLang("zh")
    expect([s().releaseDate("2026-11-20"), s().releaseDate("2025-11-20")]).toEqual(["11月20日", "2025年11月20日"])
  })
})
