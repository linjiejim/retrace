// Retrace site: language, the live commit graph, scroll effects, the gallery, keycaps and downloads.

const REPO = "linjiejim/retrace"
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

// ---------- language ----------

const T = {
  "nav.features": ["Features", "特点"],
  "nav.readonly": ["Read-only", "只读"],
  "nav.keys": ["Keyboard", "快捷键"],
  "nav.download": ["Download", "下载"],
  "hero.eyebrow": ["For the age of coding agents", "给 coding agent 时代的 Git 审查工具"],
  "hero.title": ["Rewind what your <em>agents</em> wrote.", "回看你的 <em>agent</em> 写下的每一行。"],
  "hero.lede": [
    "Retrace puts every repository, worktree and branch in one window, keeps your integration branch pinned left, and opens any commit's message and diff with a click. It never commits, merges or rewrites a thing.",
    "Retrace 把所有仓库、worktree 和分支放在一个窗口里，集成分支固定在最左列，点一下就能看任一提交的说明和 diff。它从不提交、不合并、不改写任何东西。",
  ],
  "hero.download": ["Download for macOS", "下载 macOS 版"],
  "hero.github": ["Star on GitHub", "在 GitHub 上加星"],
  "hero.meta": ["macOS 13+ · Apple silicon & Intel · Free and open source (MIT)", "macOS 13+ · Apple 芯片与 Intel · 免费开源（MIT）"],
  "window.title": ["One window. <span>Every worktree.</span>", "一个窗口，<span>所有 worktree。</span>"],
  "window.lede": [
    "Twelve worktrees, four agents, one review. Projects and changes on the left, the commit graph on top, the commit you picked underneath.",
    "十几棵 worktree、好几个 agent，一次看完。左边是项目和改动，右上是提交图，下面是你点开的那个提交。",
  ],
  "pin.1": [
    "<strong>The trunk holds column 0.</strong> Agent branches join from the right, so main is always one straight line.",
    "<strong>主干永远在第 0 列。</strong>agent 的分支从右边汇入，main 始终是一条直线。",
  ],
  "pin.2": ["<strong>Worktrees, folded.</strong> Active, merged and branch-only trees each live in one menu.", "<strong>worktree 收纳好。</strong>进行中、已合并、只有分支的，各收进一个下拉。"],
  "pin.3": ["<strong>PR in one click.</strong> Squash and merge commits link straight to the pull request.", "<strong>一键打开 PR。</strong>squash 合并和 merge 提交直接链到 GitHub 上的 PR。"],
  "pin.4": ["<strong>Diffs that read well.</strong> Side by side, highlighted off the main thread.", "<strong>好读的 diff。</strong>默认并排，语法高亮在后台线程里做。"],
  "num.trees": ["worktrees in one view", "棵 worktree 一屏看完"],
  "num.agents": ["agents, no tab juggling", "个 agent，不用来回切"],
  "num.click": ["click to the diff", "下点击就到 diff"],
  "num.writes": ["accidental commits", "次误提交"],
  "features.title": ["Review like a <span>reviewer</span>, not a git client.", "像审查者一样看，<span>而不是 git 客户端。</span>"],
  "f1.t": ["The integration branch stays left", "集成分支永远在最左列"],
  "f1.d": ["main owns column 0 of a compact, one-line graph. Other branches join only when you ask for them.", "main 占紧凑单行提交图的第 0 列。其他分支要的时候再加，先本地，可选远程。"],
  "f2.t": ["Worktrees, folded", "worktree 收纳好"],
  "f2.d": ["Active, merged and branch-only work sit in three menus. Remove merged worktrees and branches safely: no --force, checked again first, Undo for branches.", "进行中、已合并、只有分支的各收一个下拉。已合并的 worktree 和分支可以安全删除：不加 --force，删前逐项复查，删掉的分支能撤销。"],
  "f3.t": ["Diffs that read well", "好读的 diff"],
  "f3.d": ["Side by side, no wrapping, highlighted off the main thread. One file at a time, or the whole commit in a row.", "默认并排、不换行，高亮在后台线程。一个文件一个文件看，或者连续读完整个提交。"],
  "f4.t": ["Browse any version", "浏览任一版本"],
  "f4.d": ["See the whole tree as it was at any commit. Code, images, and Markdown rendered like GitHub.", "看任一提交时的整个目录：代码、图片，Markdown 像 GitHub 一样渲染。"],
  "f5.t": ["Your layout", "布局随你"],
  "f5.d": ["Drag any view to dock it beside another or swap them. Close the diff and the graph takes the space.", "拖动任一视图停靠到别的视图旁边或交换位置。关掉 diff，提交图就占满。"],
  "f6.t": ["A proper Mac app", "像样的 Mac App"],
  "f6.d": ["Native menu bar, keyboard first, light and dark, English and 中文. Built with Tauri: a few megabytes, not a browser.", "原生菜单栏、键盘优先、浅色深色、中文和 English。基于 Tauri，只有几 MB，不是一个浏览器。"],
  "ro.title": ["Two writes. <span>That's it.</span>", "只有两种写操作，<span>没了。</span>"],
  "ro.lede": [
    "Agents are busy in those trees. Retrace reads with GIT_OPTIONAL_LOCKS=0, never takes the index lock, and lists changes with plumbing that doesn't touch the index.",
    "agent 正在那些 worktree 里干活。Retrace 读的时候带 GIT_OPTIONAL_LOCKS=0，从不抢 index 锁，列改动只用不碰 index 的底层命令。",
  ],
  "ro.never": ["never", "从不"],
  "ro.fetch": ["remote-tracking branches only · can be off", "只更新远程分支 · 可关闭"],
  "ro.remove": ["merged worktrees & branches · after you confirm · no --force", "已合并的 worktree 和分支 · 你确认后 · 不加 --force"],
  "gallery.title": ["Look <span>closer.</span>", "再<span>近一点看。</span>"],
  "g.worktrees": ["Worktrees", "worktree"],
  "g.files": ["Files & README", "文件与 README"],
  "g.images": ["Image diffs", "图片对比"],
  "g.settings": ["Settings", "设置"],
  "keys.title": ["Keyboard first. <span>Try it.</span>", "键盘优先，<span>试试看。</span>"],
  "keys.lede": ["Press a key below — or on your keyboard.", "点下面的键，或者直接按键盘。"],
  "dl.title": ["Retrace <span class=\"version\">v0.4.1</span>", "Retrace <span class=\"version\">v0.4.1</span>"],
  "dl.lede": ["Free and open source. macOS 13 or later.", "免费开源，macOS 13 及以上。"],
  "dl.latest": ["Download the latest release", "下载最新版本"],
  "dl.note": [
    "Not notarised yet: if macOS refuses the first launch, choose <strong>Open Anyway</strong> in System Settings → Privacy & Security, or run <code>xattr -dr com.apple.quarantine /Applications/Retrace.app</code>.",
    "还没有经过 Apple 公证：第一次打开如果被拦，到「系统设置 → 隐私与安全性」点<strong>仍要打开</strong>，或运行 <code>xattr -dr com.apple.quarantine /Applications/Retrace.app</code>。",
  ],
  "foot.releases": ["Releases", "版本"],
  "foot.issues": ["Issues", "反馈"],
}

const CAPTIONS = {
  worktrees: ["Worktrees still being worked on, with uncommitted files and ahead / behind, folded into one menu.", "还在干活的 worktree 收在一个下拉里，带未提交文件数和领先 / 落后。"],
  files: ["Any version's files. The README renders like on GitHub, images included.", "任一版本的文件。README 像在 GitHub 上一样渲染，图片也在。"],
  images: ["A commit that replaced screenshots: every image before and after, then the text diffs.", "一个替换了截图的提交：每张图改前改后，下面接着是文字 diff。"],
  settings: ["Settings in grouped cards: language, theme, layout, fetch, editor, terminal, browser.", "分组卡片里的设置：语言、主题、布局、自动获取、编辑器、终端、浏览器。"],
}

const KEYS = {
  "ArrowUp ArrowDown j k": ["Previous / next commit", "上一个 / 下一个提交"],
  "ArrowRight Enter": ["Into the commit's changes, diff opens", "进入提交的改动，打开 diff"],
  ArrowLeft: ["Back to the graph", "回到提交图"],
  "f F": ["Focus: only the changes and the diff", "专注：只留改动和 diff"],
  Escape: ["Leave focus → close the diff → clear the filter", "退出专注 → 关闭 diff → 清空筛选"],
  "mod+j": ["Show or hide the diff", "打开 / 关闭 diff"],
  "mod+\\": ["Show or hide the projects", "收起 / 展开项目栏"],
  "mod+,": ["Settings", "设置"],
}

const prefersZh = (navigator.languages || [navigator.language]).some((l) => l?.toLowerCase().startsWith("zh"))
let lang = localStorage.getItem("retrace.site.lang") || (prefersZh ? "zh" : "en")
const pick = (pair) => pair[lang === "zh" ? 1 : 0]

function applyLang() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"
  for (const el of document.querySelectorAll("[data-i18n]")) if (T[el.dataset.i18n]) el.textContent = pick(T[el.dataset.i18n])
  for (const el of document.querySelectorAll("[data-i18n-html]")) if (T[el.dataset.i18nHtml]) el.innerHTML = pick(T[el.dataset.i18nHtml])
  for (const img of document.querySelectorAll("img[data-src-en]")) img.src = lang === "zh" ? img.dataset.srcZh : img.dataset.srcEn
  document.getElementById("lang").textContent = lang === "zh" ? "English" : "中文"
  document.title = lang === "zh" ? "Retrace — 回看你的 agent 写下的每一行" : "Retrace — rewind what your agents wrote"
  showShot(currentShot, false)
  if (release) renderDownloads(release)
}
document.getElementById("lang").addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh"
  localStorage.setItem("retrace.site.lang", lang)
  applyLang()
})

// ---------- the live commit graph ----------
// Rows stream upward like scrolling back through `git log`: the trunk keeps column 0, merge
// commits open side lanes for agent branches, and each branch curves back into the trunk at its
// fork point — the same layout rules as the app.

const svg = document.getElementById("graph")
const NS = "http://www.w3.org/2000/svg"
const ROW = 34
const LANE = 22
const X0 = 30
const COLORS = ["var(--lane-0)", "var(--lane-1)", "var(--lane-2)", "var(--lane-3)", "var(--lane-4)", "var(--lane-5)"]
const AGENTS = ["claude", "codex", "cursor", "agent"]
const TOPICS = ["fix-auth-refresh", "paginate-feed", "dark-editor", "sso-e2e", "cli-json", "cache-trunk", "onboarding-copy", "retry-uploads", "drop-legacy-api", "faster-search", "i18n-zh", "worktree-cleanup"]
const MESSAGES = [
  "fix(auth): refresh tokens before they expire",
  "feat(api): paginate the activity feed",
  "test: cover the retry path",
  "refactor(db): one query for the dashboard",
  "docs: explain worktree cleanup",
  "fix(ui): keep the selection on reload",
  "perf: cache the trunk compare",
  "feat(cli): --json output",
  "fix: handle a detached HEAD",
  "test(e2e): sign in with SSO",
  "feat: dark mode for the editor",
  "chore: bump dependencies",
  "fix(sync): don't drop the last page",
  "feat(search): rank exact matches first",
  "refactor: split the settings screen",
  "fix(upload): resume after a timeout",
]
const rand = (n) => Math.floor(Math.random() * n)
const pickOne = (a) => a[rand(a.length)]
const x = (col) => X0 + col * LANE

const g = document.createElementNS(NS, "g")
svg.append(g)
let rowIndex = 0
let pr = 180
/** Side lanes by column: { color, left (commits still to place), waiting (joins trunk next) } */
const lanes = [null, null, null, null, null]
let colorTurn = 1

function el(name, attrs, parent = g) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  parent.append(e)
  return e
}

function label(row, y, text, pill) {
  const tx = x(lanes.length + 1)
  if (pill) {
    const p = el("g", { class: "pill" }, row)
    const w = pill.text.length * 6.6 + 16
    el("rect", { x: tx, y: y - 10, width: w, height: 20, rx: 6, fill: pill.color }, p)
    el("text", { x: tx + 8, y: y + 4, fill: pill.color }, p).textContent = pill.text
    el("text", { x: tx + w + 10, y: y + 4.5 }, row).textContent = text
  } else {
    el("text", { x: tx, y: y + 4.5 }, row).textContent = text
  }
}

/** One more (older) row at the bottom. */
function addRow() {
  const i = rowIndex++
  const top = i * ROW
  const mid = top + ROW / 2
  const row = el("g", { class: "row", "data-row": i })
  const active = lanes.map((l, c) => (l ? c : -1)).filter((c) => c > 0)
  const busy = active.filter((c) => lanes[c].left > 0)
  const trunkTurn = busy.length === 0 || Math.random() < 0.3

  // Pass-through lines for every lane that doesn't change in this row.
  const passing = (c) => el("path", { d: `M${x(c)} ${top}V${top + ROW}`, stroke: lanes[c].color, "stroke-width": 1.8, fill: "none" }, row)

  if (trunkTurn) {
    // Waiting branches reach their fork point on the trunk: curve in.
    const joining = active.filter((c) => lanes[c].left === 0 && Math.random() < 0.7)
    for (const c of active) if (!joining.includes(c)) passing(c)
    for (const c of joining) {
      el("path", { d: `M${x(c)} ${top}V${mid - 8}Q${x(c)} ${mid} ${x(c) - 8} ${mid}H${x(0)}`, stroke: lanes[c].color, "stroke-width": 1.8, fill: "none" }, row)
      lanes[c] = null
    }
    const free = lanes.findIndex((l, c) => c > 0 && !l)
    const merge = free > 0 && active.length < 4 && Math.random() < 0.62
    if (merge) {
      const color = COLORS[colorTurn]
      colorTurn = (colorTurn % (COLORS.length - 1)) + 1
      lanes[free] = { color, left: 2 + rand(4) }
      el("path", { d: `M${x(0)} ${mid}H${x(free) - 8}Q${x(free)} ${mid} ${x(free)} ${mid + 8}V${top + ROW}`, stroke: color, "stroke-width": 1.8, fill: "none" }, row)
      lanes[free].branch = `${pickOne(AGENTS)}/${pickOne(TOPICS)}`
      el("circle", { cx: x(0), cy: mid, r: 5, fill: "var(--bg)", stroke: COLORS[0], "stroke-width": 2.2 }, row)
      label(row, mid, `Merge pull request #${pr--} from ${lanes[free].branch}`)
    } else {
      el("circle", { cx: x(0), cy: mid, r: 4.5, fill: COLORS[0] }, row)
      label(row, mid, `${pickOne(MESSAGES)} (#${pr--})`)
    }
  } else {
    // A commit on one of the agent branches.
    const c = pickOne(busy)
    const lane = lanes[c]
    for (const o of active) if (o !== c) passing(o)
    passing(c)
    const tip = !lane.started
    lane.started = true
    lane.left--
    el("circle", { cx: x(c), cy: mid, r: 4.5, fill: lane.color }, row)
    label(row, mid, pickOne(MESSAGES), tip ? { text: lane.branch, color: lane.color } : null)
  }
  // The trunk line runs through every row, under the dots.
  row.prepend(el("path", { d: `M${x(0)} ${top}V${top + ROW}`, stroke: COLORS[0], "stroke-width": 2.4, fill: "none" }, row))
}

let offset = 0
let last = performance.now()
function frame(now) {
  const h = svg.clientHeight || 800
  const dt = Math.min(64, now - last)
  last = now
  offset += dt * 0.022
  // Keep rows filled to just below the bottom edge, and drop the ones that scrolled off the top.
  while (rowIndex * ROW < offset + h + ROW) addRow()
  for (const r of [...g.children]) if ((+r.dataset.row + 1) * ROW < offset - ROW) r.remove()
  g.setAttribute("transform", `translate(0 ${-offset})`)
  if (!reduced) requestAnimationFrame(frame)
}
if (reduced) {
  for (let i = 0; i < 30; i++) addRow()
} else {
  requestAnimationFrame(frame)
}

// ---------- nav border, reveal, tilting window, counters ----------

const nav = document.querySelector(".nav")
const mac = document.getElementById("mac")
function onScroll() {
  nav.classList.toggle("scrolled", scrollY > 10)
  if (!reduced && mac) {
    const r = mac.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, 1 - (r.top - innerHeight * 0.15) / (innerHeight * 0.75)))
    mac.style.setProperty("--tilt", `${(1 - p) * 22}deg`)
    mac.style.setProperty("--scale", String(0.9 + p * 0.1))
  }
}
addEventListener("scroll", onScroll, { passive: true })
onScroll()

for (const el of document.querySelectorAll(".section-title, .section-lede, .legend, .numbers, .card, .term, .frame, .caps, .download > *")) el.classList.add("reveal")
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add("in")
      if (e.target.id === "term") setTimeout(() => e.target.classList.add("play"), 300)
      if (e.target.classList.contains("numbers")) countUp(e.target)
      io.unobserve(e.target)
    }
  },
  { threshold: 0.2 },
)
document.querySelectorAll(".reveal").forEach((el) => io.observe(el))

/** The read-only lines get struck out one after another. */
document.querySelectorAll("#term .no code").forEach((c, i) => (c.style.transitionDelay = `${i * 0.22}s`))
const strike = document.createElement("style")
strike.textContent = [...document.querySelectorAll("#term .no")].map((_, i) => `#term .no:nth-child(${i + 1}) code::after { transition-delay: ${i * 0.22}s; }`).join("\n")
document.head.append(strike)

function countUp(box) {
  for (const b of box.querySelectorAll("b[data-count]")) {
    const to = +b.dataset.count
    const start = performance.now()
    const tick = (t) => {
      const k = Math.min(1, (t - start) / 900)
      b.textContent = String(Math.round(to * (1 - (1 - k) ** 3)))
      if (k < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
}

// Cards: a soft light follows the pointer.
for (const card of document.querySelectorAll(".card")) {
  card.addEventListener("pointermove", (e) => {
    const r = card.getBoundingClientRect()
    card.style.setProperty("--mx", `${e.clientX - r.left}px`)
    card.style.setProperty("--my", `${e.clientY - r.top}px`)
  })
}

// Pins on the window and their legend light up together.
for (const el of document.querySelectorAll("[data-pin]")) {
  const n = el.dataset.pin
  const both = document.querySelectorAll(`[data-pin="${n}"]`)
  el.addEventListener("pointerenter", () => both.forEach((b) => b.classList.add("on")))
  el.addEventListener("pointerleave", () => both.forEach((b) => b.classList.remove("on")))
  el.addEventListener("focus", () => both.forEach((b) => b.classList.add("on")))
  el.addEventListener("blur", () => both.forEach((b) => b.classList.remove("on")))
}

// ---------- gallery ----------

let currentShot = "worktrees"
const shot = document.getElementById("gallery-shot")
function showShot(name, animate = true) {
  currentShot = name
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.shot === name))
  const src = `screens/${lang}/${name}.webp`
  document.getElementById("gallery-caption").textContent = pick(CAPTIONS[name])
  shot.alt = pick(CAPTIONS[name])
  if (!animate) return void (shot.src = src)
  shot.classList.add("fade")
  setTimeout(() => {
    shot.src = src
    shot.onload = () => shot.classList.remove("fade")
  }, 180)
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showShot(b.dataset.shot))

// ---------- keycaps ----------

const out = document.getElementById("keys-out")
function press(cap) {
  cap.classList.add("hit")
  setTimeout(() => cap.classList.remove("hit"), 220)
  const desc = KEYS[cap.dataset.key]
  out.innerHTML = `<b>${cap.innerText.replace(/\s+/g, " ")}</b> &nbsp; ${pick(desc)}`
}
const caps = [...document.querySelectorAll(".cap")]
caps.forEach((c) => c.addEventListener("click", () => press(c)))
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLElement && e.target.closest("input, textarea")) return
  const id = (e.metaKey || e.ctrlKey ? "mod+" : "") + e.key.toLowerCase()
  const cap = caps.find((c) => c.dataset.key.split(" ").some((k) => k.toLowerCase() === id || (!e.metaKey && !e.ctrlKey && k === e.key)))
  const keys = document.getElementById("keys").getBoundingClientRect()
  // Only while the keyboard section is on screen, and without taking browser shortcuts away.
  if (cap && keys.top < innerHeight && keys.bottom > 0) press(cap)
})

// ---------- downloads from the latest release ----------

let release = null
function renderDownloads(rel) {
  for (const v of document.querySelectorAll(".version")) v.textContent = rel.tag_name
  const dmg = (re) => rel.assets.find((a) => a.name.endsWith(".dmg") && re.test(a.name))
  const arm = dmg(/aarch64|arm64/)
  const intel = dmg(/x64|x86_64|intel/i)
  const box = document.getElementById("dl-buttons")
  if (!arm && !intel) return
  box.innerHTML = ""
  const link = (asset, text, primary) => {
    const a = document.createElement("a")
    a.className = `btn ${primary ? "primary" : "ghost"}`
    a.href = asset.browser_download_url
    a.textContent = text
    box.append(a)
  }
  if (arm) link(arm, lang === "zh" ? "Apple 芯片（.dmg）" : "Apple silicon (.dmg)", true)
  if (intel) link(intel, lang === "zh" ? "Intel（.dmg）" : "Intel (.dmg)", false)
}
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : null))
  .then((rel) => {
    if (!rel) return
    release = rel
    renderDownloads(rel)
  })
  .catch(() => {})

applyLang()
