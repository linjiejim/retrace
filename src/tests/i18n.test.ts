import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { zh } from "@/locales/zh"
import { PANEL_TITLE } from "@/lib/layout"
import { STATUS_LABEL } from "@/lib/tree"

const root = path.resolve(__dirname, "..")
function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p)
  }
  return out
}
const sources = files(root).filter((f) => !f.includes(`${path.sep}locales${path.sep}`))
const read = (f: string) => fs.readFileSync(f, "utf8")

/** String literal at the start of `rest` ("…" or '…' or `…` without interpolation). */
const literal = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/

function keys(): { key: string; where: string }[] {
  const out: { key: string; where: string }[] = []
  for (const f of sources) {
    const text = read(f)
    for (const m of text.matchAll(/\b(t|tp)\(/g)) {
      let rest = text.slice(m.index! + m[0].length)
      let lit = literal.exec(rest)
      if (m[1] === "tp" && lit) {
        rest = rest.slice(lit[0].length).replace(/^\s*,/, "")
        lit = literal.exec(rest)
      }
      if (lit) out.push({ key: JSON.parse(`"${lit[2].replace(/"/g, '\\"').replace(/\\'/g, "'")}"`), where: path.relative(root, f) })
    }
  }
  return out
}

describe("i18n", () => {
  it("has Chinese for every string passed to t() and tp()", () => {
    const missing = keys().filter((k) => !(k.key in zh))
    expect(missing.map((k) => `${k.where}: ${k.key}`)).toEqual([])
  })

  it("has Chinese for the labels shown through t(variable)", () => {
    const labels = [...Object.values(PANEL_TITLE), ...Object.values(STATUS_LABEL)]
    expect(labels.filter((l) => !(l in zh))).toEqual([])
  })

  it("leaves no Chinese text outside the dictionaries", () => {
    // Kit defaults and the Chinese date formats may hold Chinese; elsewhere a line needs `i18n-allow: <why>`.
    const allowed = ["lib/strings.ts", "lib/format.ts"]
    const hits: string[] = []
    for (const f of sources) {
      const rel = path.relative(root, f)
      if (allowed.includes(rel)) continue
      read(f)
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim()
          if (/^(\/\/|\/\*|\*)/.test(code) || code.includes("i18n-allow:")) return
          if (/[一-鿿]/.test(code.replace(/\/\/.*$/, ""))) hits.push(`${rel}:${i + 1}  ${code.slice(0, 100)}`)
        })
    }
    expect(hits).toEqual([])
  })
})
