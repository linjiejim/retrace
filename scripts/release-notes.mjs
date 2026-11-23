#!/usr/bin/env node
// Release notes from CHANGELOG.md, and a first draft of the next section from Conventional Commits.
// Format and flow: jim-uiux references/patterns/updates.md. No dependencies: Node ≥ 20 and git.
//
//   node scripts/release-notes.mjs draft [--version X.Y.Z] [--write]
//       The next section, from the feat / fix / perf commits since the last release tag. Prints it,
//       or with --write puts it at the top of the changelog to be edited into plain words.
//   node scripts/release-notes.mjs notes <X.Y.Z> [--fallback] [--also CHANGELOG.zh-CN.md]
//       That version's section without its heading: the GitHub release body, an updater's `notes`.
//       --fallback: when the section is missing, draft it from the commits and warn instead of failing.
//       --also: append the same version from a translated changelog, after a rule.
//   node scripts/release-notes.mjs check [<X.Y.Z>]
//       Fails when the version (default: package.json's) has no notes.
//
// Options: --file CHANGELOG.md · --tag-prefix v (turnery: turnery-v) · --since <ref> (instead of
// the last tag: a project's first release) · --path <dir> and
// --skip-scope <scope> (both repeatable: only commits touching these paths / not these scopes)
// · --package desktop/package.json (where the version lives) · --lang zh|en (draft headings;
// default: whatever the file already uses, else zh) · --date YYYY-MM-DD
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { pathToFileURL } from "node:url"

export const HEADINGS = {
  zh: { "heads-up": "注意", new: "新增", improved: "改进", fixed: "修复" },
  en: { "heads-up": "Heads-up", new: "New", improved: "Improved", fixed: "Fixed" },
}
const KIND_OF_TYPE = { feat: "new", fix: "fixed", perf: "improved", revert: "fixed" }
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:[\s(·—–-]|$)/

/** One commit → { kind, text, breaking } or null when it isn't for the people using the app. */
export function parseCommit(subject, body = "", { skipScopes = [] } = {}) {
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim())
  if (!m) return null
  const [, type, scope = "", bang, rest] = m
  if (type === "chore" && scope === "release") return null
  if (skipScopes.includes(scope)) return null
  const text = rest
    .replace(/\s*\[skip ci\]/gi, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .trim()
  const note = /^BREAKING[ -]CHANGE:\s*(.+)$/m.exec(body)
  const breaking = bang || note ? (note?.[1] ?? text).trim() : null
  const kind = KIND_OF_TYPE[type]
  if (!kind && !breaking) return null
  return { kind: kind ?? null, text, breaking }
}

/** Commits → { "heads-up": [], new: [], improved: [], fixed: [] }, duplicates dropped. */
export function groupCommits(commits, opts) {
  const groups = { "heads-up": [], new: [], improved: [], fixed: [] }
  for (const c of commits) {
    const p = parseCommit(c.subject, c.body, opts)
    if (!p) continue
    if (p.breaking && !groups["heads-up"].includes(p.breaking)) groups["heads-up"].push(p.breaking)
    if (p.kind && !groups[p.kind].includes(p.text)) groups[p.kind].push(p.text)
  }
  return groups
}

const parse = (v) => {
  const m = SEMVER.exec(v)
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : null
}

export function compareVersions(a, b) {
  const [pa, pb] = [parse(a), parse(b)]
  for (const k of ["major", "minor", "patch"]) if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true }) < 0 ? -1 : 1
}

/** The SemVer bump the groups call for; before 1.0 a breaking change bumps the minor. */
export function nextVersion(prev, groups) {
  const v = parse(prev ?? "") ?? parse("0.0.0")
  if (groups["heads-up"].length) return v.major === 0 ? `0.${v.minor + 1}.0` : `${v.major + 1}.0.0`
  if (groups.new.length) return `${v.major}.${v.minor + 1}.0`
  return `${v.major}.${v.minor}.${v.patch + 1}`
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** A body (no heading) in the template's order: heads-up, new, improved, fixed. */
export function renderBody(groups, lang = "zh") {
  const h = HEADINGS[lang] ?? HEADINGS.zh
  const parts = []
  for (const kind of ["heads-up", "new", "improved", "fixed"]) {
    if (!groups[kind].length) continue
    const items = groups[kind].map((t) => `- ${lang === "en" ? capitalise(t) : t}`)
    parts.push(`### ${h[kind]}\n\n${items.join("\n")}`)
  }
  return parts.join("\n\n")
}

export const renderSection = (version, date, body) => `## ${version} · ${date}\n\n${body}\n`

/** The section for `version`: { start, end } line indexes and its body, or null. A rule (---) ends it too. */
export function findSection(markdown, version) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => VERSION_HEADING.exec(l)?.[1] === version)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]) && !/^-{3,}\s*$/.test(lines[end])) end++
  return { start, end, body: lines.slice(start + 1, end).join("\n").trim() }
}

/** Puts a section above the newest one (below the title and intro). */
export function insertSection(markdown, section) {
  const lines = markdown.split(/\r?\n/)
  const at = lines.findIndex((l) => /^##\s/.test(l))
  if (at < 0) return `${markdown.trimEnd()}\n\n${section}`
  return [...lines.slice(0, at), ...section.trimEnd().split("\n"), "", ...lines.slice(at)].join("\n")
}

export function detectLang(markdown) {
  if (/^###\s+(New|Improved|Fixed|Added|Changed|Heads-up)\b/m.test(markdown)) return "en"
  return "zh"
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/** The newest release tag older than `version` (any, when `version` is unknown). */
export function previousTag(prefix, version) {
  const tags = git("tag", "--list", `${prefix}*`)
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t && parse(t.slice(prefix.length)))
  const older = tags.filter((t) => !version || compareVersions(t.slice(prefix.length), version) < 0)
  older.sort((a, b) => compareVersions(b.slice(prefix.length), a.slice(prefix.length)))
  return older[0] ?? null
}

function commitsSince(tag, paths) {
  const out = git("log", "--no-merges", "--format=%s%x1f%b%x1e", tag ? `${tag}..HEAD` : "HEAD", "--", ...paths)
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [subject, body = ""] = r.split("\x1f")
      return { subject, body }
    })
}

// ── cli ──────────────────────────────────────────────────────────────────────────────────────────

function args(argv) {
  const opts = { _: [], path: [], "skip-scope": [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) opts._.push(a)
    else if (["write", "fallback"].includes(a.slice(2))) opts[a.slice(2)] = true
    else if (Array.isArray(opts[a.slice(2)])) opts[a.slice(2)].push(argv[++i])
    else opts[a.slice(2)] = argv[++i]
  }
  return opts
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const fail = (message) => {
  console.error(`::error::${message}`)
  process.exit(1)
}
const readFile = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")

function draft(o, version) {
  const prefix = o["tag-prefix"] ?? "v"
  const tag = previousTag(prefix, version)
  const since = o.since ?? tag
  if (!since) console.error(`release-notes: no ${prefix}* tag before ${version ?? "HEAD"}, so every commit counts`)
  const groups = groupCommits(commitsSince(since, o.path), { skipScopes: o["skip-scope"] })
  // no tag yet: the version in package.json is the one out there
  const base = tag?.slice(prefix.length) ?? JSON.parse(readFile(o.package ?? "package.json") || "{}").version
  return { since, groups, version: version ?? nextVersion(base, groups) }
}

function main() {
  const o = args(process.argv.slice(2))
  const [command, given] = o._
  const file = o.file ?? "CHANGELOG.md"
  const markdown = readFile(file)

  if (command === "draft") {
    const d = draft(o, o.version)
    const lang = o.lang ?? detectLang(markdown)
    const body = renderBody(d.groups, lang) || (lang === "en" ? "- Small fixes." : "- 小修小补。")
    const section = renderSection(d.version, o.date ?? today(), body)
    if (!o.write) return void process.stdout.write(section)
    if (findSection(markdown, d.version)) fail(`${file} already has a ${d.version} section`)
    const title = lang === "en" ? "# Changelog\n" : "# 更新记录\n"
    fs.writeFileSync(file, insertSection(markdown || title, section).replace(/\n*$/, "\n"))
    console.error(`${file}: drafted ${d.version} from the commits since ${d.since ?? "the start"}; now write it for the people using the app`)
    return
  }

  if (command === "notes") {
    if (!given || !parse(given)) fail("notes needs a version: release-notes.mjs notes 1.2.3")
    let body = findSection(markdown, given)?.body
    if (!body) {
      if (!o.fallback) fail(`${file} has no ${given} section`)
      console.error(`::warning::${file} has no ${given} section, so these notes were drafted from the commits. Edit the release before publishing it.`)
      body = renderBody(draft(o, given).groups, o.lang ?? detectLang(markdown)) || "-"
    }
    const extra = o.also && findSection(readFile(o.also), given)?.body
    process.stdout.write(`${body}${extra ? `\n\n---\n\n${extra}` : ""}\n`)
    return
  }

  if (command === "check") {
    const pkg = o.package ?? "package.json"
    const version = given ?? JSON.parse(readFile(pkg) || "{}").version
    if (!version) fail(`no version given and none in ${pkg}`)
    const section = findSection(markdown, version)
    if (!section?.body) fail(`${file} has no notes for ${version}: run 'node scripts/release-notes.mjs draft --version ${version} --write' and edit it`)
    console.log(`${file}: ${version} has notes`)
    return
  }

  console.error("usage: release-notes.mjs draft [--version X.Y.Z] [--write] | notes <X.Y.Z> [--fallback] | check [<X.Y.Z>]")
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main()
