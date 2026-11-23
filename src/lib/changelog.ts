/**
 * Release notes: a project's CHANGELOG.md read into versions, and the ones a person hasn't seen yet.
 *
 * The format (references/patterns/updates.md): one `## <version> · <date>` per release, newest
 * first; an optional one-line summary; then `### 注意 / 新增 / 改进 / 修复` (or Heads-up / New /
 * Improved / Fixed; Keep a Changelog's Added / Changed / Fixed and release-please's
 * `## [4.2.0](…) (2026-11-05)` headings read the same) with one `- ` item each. Items written
 * before any `###` form one untitled group. Trailing commit and PR links are dropped: the people
 * reading the notes in the app don't need them.
 */

export type ReleaseKind = "heads-up" | "new" | "improved" | "fixed" | "other"
export type ReleaseGroup = { kind: ReleaseKind; title: string; items: string[] }
export type Release = { version: string; date?: string; summary?: string; groups: ReleaseGroup[] }

const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\([^)]*\))?\s*(?:[·—–-]\s*)?\(?(\d{4}-\d{2}-\d{2})?\)?\s*$/
const KINDS: [ReleaseKind, RegExp][] = [
  ["heads-up", /注意|升级须知|需要你|破坏|breaking|heads-up|before you update|action needed/i],
  ["new", /新增|新功能|added|^new\b|features?/i],
  ["improved", /改进|优化|变更|changed|improved|improvements?|performance/i],
  ["fixed", /修复|fixed|bug ?fixes/i],
]
// " ([#12](…))", " ([1a2b3c4](…))", " (#12)", " (1a2b3c4)"
const TRAILING_REF = /\s*\((?:\[[^\]]+\]\([^)]*\)|#\d+|[0-9a-f]{7,40})\)\s*$/

const kindOf = (title: string): ReleaseKind => KINDS.find(([, re]) => re.test(title))?.[0] ?? "other"

function clean(item: string) {
  let text = item.trim()
  for (let prev = ""; prev !== text; ) {
    prev = text
    text = text.replace(TRAILING_REF, "")
  }
  return text
}

/** Newest first, as written. Sections without a version (`## Unreleased`) are skipped. */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  let release: Release | null = null
  let group: ReleaseGroup | null = null
  let item: string[] | null = null
  let summary: string[] = []

  const endItem = () => {
    if (item && group) group.items.push(clean(item.join(" ")))
    item = null
  }
  const endRelease = () => {
    endItem()
    if (release) {
      if (summary.length) release.summary = summary.join(" ")
      release.groups = release.groups.filter((g) => g.items.length)
      releases.push(release)
    }
    release = null
    group = null
    summary = []
  }

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^#{1,2}\s/.test(line)) {
      endRelease()
      const m = VERSION_HEADING.exec(line)
      if (m) release = { version: m[1], date: m[2], groups: [] }
      continue
    }
    if (!release) continue
    const r: Release = release
    const heading = /^###\s+(.+)$/.exec(line)
    if (heading) {
      endItem()
      const title = heading[1].replace(/\u26a0\ufe0f?/gu, "").trim() // release-please: "### ⚠ BREAKING CHANGES"
      group = { kind: kindOf(title), title, items: [] }
      r.groups.push(group)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      endItem()
      if (!group) {
        group = { kind: "other", title: "", items: [] }
        r.groups.push(group)
      }
      item = [bullet[1]]
      continue
    }
    if (!line.trim() || /^-{3,}$/.test(line.trim())) {
      endItem()
      continue
    }
    // indented continuation or a nested bullet: part of the item above
    if (item && /^\s+/.test(raw)) {
      item.push(line.trim().replace(/^[-*]\s+/, ""))
      continue
    }
    // prose before the first item is the summary; prose after it is for the file, not the app
    if (!r.groups.length) summary.push(line.trim())
  }
  endRelease()
  return releases
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** -1, 0 or 1 by SemVer precedence; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) throw new Error(`Not a version: ${pa ? b : a}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d) return d < 0 ? -1 : 1
  }
  const [xa, xb] = [pa[4], pb[4]]
  if (xa === xb) return 0
  if (!xa) return 1
  if (!xb) return -1
  const sa = xa.split(".")
  const sb = xb.split(".")
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1
    if (sb[i] === undefined) return 1
    if (sa[i] === sb[i]) continue
    const na = /^\d+$/.test(sa[i])
    const nb = /^\d+$/.test(sb[i])
    if (na && nb) return Number(sa[i]) < Number(sb[i]) ? -1 : 1
    if (na !== nb) return na ? -1 : 1
    return sa[i] < sb[i] ? -1 : 1
  }
  return 0
}

/**
 * The releases after `seen` up to and including `current`, newest first, that have something to
 * say. Nothing when `seen` is unknown (a first install has nothing to catch up on) or not older.
 */
export function unseenReleases(releases: Release[], seen: string | null | undefined, current: string): Release[] {
  if (!seen || !SEMVER.test(seen) || compareVersions(current, seen) <= 0) return []
  return releases
    .filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0)
    .filter((r) => r.groups.length)
    .sort((a, b) => compareVersions(b.version, a.version))
}
