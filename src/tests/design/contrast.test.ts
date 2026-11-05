/**
 * Contrast matrix for every theme scope (light, dark, each preset in both).
 * Reads the CSS, resolves var() and color-mix(in oklab, …), flattens alpha
 * over the surface, and checks WCAG ratios. Turning a knob that breaks
 * legibility fails here, not in production.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { converter, formatRgb, parse, wcagContrast, type Color } from "culori"
import { loadConfig, root, themePaths } from "./guard-lib"

type Decls = Record<string, string>
const cfg = loadConfig()

function blocks(css: string) {
  const out: { selector: string; decls: Decls }[] = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const m of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decls: Decls = {}
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim()
    const selector = m[1].split(";").pop()!.trim()
    if (Object.keys(decls).length) out.push({ selector, decls })
  }
  return out
}

const all = themePaths(cfg)
  .filter((f) => fs.existsSync(path.join(root, f)))
  .flatMap((f) => blocks(fs.readFileSync(path.join(root, f), "utf8")))

const pick = (pred: (sel: string) => boolean) =>
  all.filter((b) => b.selector.split(",").some((s) => pred(s.trim()))).reduce<Decls>((acc, b) => ({ ...acc, ...b.decls }), {})

const presets = [...new Set(all.flatMap((b) => [...b.selector.matchAll(/data-theme="([\w-]+)"/g)].map((m) => m[1])))]

const scopes: Record<string, Decls> = {
  light: pick((s) => s === ":root"),
  dark: { ...pick((s) => s === ":root"), ...pick((s) => s === ".dark") },
}
for (const p of presets) {
  const light = pick((s) => s === `[data-theme="${p}"]`)
  const dark = pick((s) => s === `.dark[data-theme="${p}"]` || s === `[data-theme="${p}"] .dark`)
  scopes[`${p} light`] = { ...scopes.light, ...light }
  scopes[`${p} dark`] = { ...scopes.dark, ...light, ...dark }
}

const toLab = converter("oklab")

function resolve(value: string, decls: Decls, depth = 0): Color {
  if (depth > 20) throw new Error(`var() cycle in ${value}`)
  const v = value.trim()
  const ref = v.match(/^var\((--[\w-]+)\)$/)
  if (ref) {
    if (!decls[ref[1]]) throw new Error(`undefined ${ref[1]}`)
    return resolve(decls[ref[1]], decls, depth + 1)
  }
  const mix = v.match(/^color-mix\(\s*in\s+oklab\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)\)$/)
  if (mix) {
    const a = toLab(resolve(mix[1], decls, depth + 1))
    const b = toLab(resolve(mix[3], decls, depth + 1))
    const p = Number(mix[2]) / 100
    const lerp = (x = 0, y = 0) => x * p + y * (1 - p)
    return { mode: "oklab", l: lerp(a.l, b.l), a: lerp(a.a, b.a), b: lerp(a.b, b.b), alpha: lerp(a.alpha ?? 1, b.alpha ?? 1) }
  }
  const c = parse(v)
  if (!c) throw new Error(`can't parse colour "${v}"`)
  return c
}

/** Composite a translucent colour over an opaque one. */
function over(fg: Color, bg: Color): Color {
  const a = fg.alpha ?? 1
  if (a >= 1) return fg
  const rgb = converter("rgb")
  const f = rgb(fg)
  const b = rgb(bg)
  return { mode: "rgb", r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a) }
}

const surfaces = ["--background", "--sunken", "--popover"]
const rules: [fg: string, bgs: string[], min: number][] = [
  ["--foreground", [...surfaces, "--muted", "--selected", "--destructive-subtle"], 7],
  ["--muted-foreground", [...surfaces, "--muted", "--selected"], 4.5],
  ["--faint-foreground", surfaces, 4.5],
  ["--primary-foreground", ["--primary"], 4.5],
  ["--background", ["--destructive"], 4.5],
  ["--inverse-foreground", ["--inverse"], 4.5],
  ["--destructive", ["--background", "--popover", "--destructive-subtle"], 4.5],
  ["--success", ["--background", "--popover", "--success-subtle"], 4.5],
  ["--warning", ["--background", "--popover", "--warning-subtle"], 4.5],
  ["--info", ["--background", "--popover", "--info-subtle"], 4.5],
  ["--primary", ["--background", "--popover"], 3],
  ["--ring", ["--background", "--popover"], 3],
]

// Tokens every scope must define and resolve; a missing one means broken
// focus rings or invisible text, not a skipped check.
const required = [...new Set(rules.flatMap(([fg, bgs]) => [fg, ...bgs]))]

describe("theme contrast", () => {
  it("finds the theme", () => {
    expect(Object.keys(scopes.light).length, `no :root tokens in ${cfg.themeFiles.join(", ")}`).toBeGreaterThan(10)
  })

  for (const [scope, decls] of Object.entries(scopes)) {
    it(`${scope}: text and accents meet WCAG`, () => {
      const fails: string[] = []
      for (const t of required) {
        try {
          resolve(`var(${t})`, decls)
        } catch (e) {
          fails.push(`${t}: ${(e as Error).message}`)
        }
      }
      expect(fails, `Missing or broken tokens:\n${fails.join("\n")}`).toEqual([])
      const canvas = resolve("var(--background)", decls)
      for (const [fg, bgs, min] of rules) {
        for (const bg of bgs) {
          const b = over(resolve(`var(${bg})`, decls), canvas)
          const f = over(resolve(`var(${fg})`, decls), b)
          const r = wcagContrast(f, b)
          if (r < min) fails.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}  (${formatRgb(f)} on ${formatRgb(b)})`)
        }
      }
      expect(fails, fails.join("\n")).toEqual([])
    })
  }
})
