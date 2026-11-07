import { useSyncExternalStore } from "react"
import { DEFAULT_LAYOUT, isValid, type Node } from "./layout"
import type { Candidate } from "./types"
import type { LangPref } from "./i18n"

/** A tiny observable store. Selectors must return primitives or stable references. */
export function createStore<T extends object>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
}

export function useStore<T extends object, U>(store: ReturnType<typeof createStore<T>>, selector: (s: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}

export type Selection = { kind: "commit"; hash: string } | { kind: "worktree" } | { kind: "compare" }

/** The add-projects dialog: type a path (browser), or tick the repositories found inside a folder. */
export type AddState = { step: "path" } | { step: "pick"; candidates: Candidate[] }

export interface UiState {
  projectId: string | null
  /** Tab per project: `tree:<path>` or `branch:<name>`. */
  tabs: Record<string, string>
  /** The branch opened from the 分支 menu, per project (at most one). */
  branchTabs: Record<string, string[]>
  selection: Selection | null
  file: { path: string; oldPath: string | null } | null
  /** Bumped when the user picks a file, so continuous reading scrolls to it (scrolling itself doesn't). */
  jump: number
  /** Files in the order the changes list shows them (tree order, collapsed folders skipped). */
  fileOrder: string[]
  query: string
  focusArea: "graph" | "changes"
  /** Diff takes the whole window. */
  focusMode: boolean
  /** The diff (or file preview) area is shown. Clicking the selected graph row toggles it. */
  diffOpen: boolean
  /** File previewed in the files view: a path in the selected version. */
  preview: string | null
  /** The graph lists only this file's commits (set by picking a file in the files view). */
  historyFile: string | null
  settingsOpen: boolean
  adding: AddState | null
  /** A fetch from the remote is running. */
  fetching: boolean
}

export interface Prefs {
  diffStyle: "split" | "unified"
  /** One file at a time, or every changed file stacked for continuous reading. */
  diffView: "file" | "all"
  listMode: "tree" | "list"
  /** Left of the diff: this selection's changes, or every file in the selected version. */
  changesMode: "changes" | "files"
  /** Markdown and SVG previews: rendered, or their source. */
  rendered: boolean
  /** The selected commit's message body above the diff (folded away when false). */
  commitBody: boolean
  /** UI language; "system" follows the macOS language. */
  language: LangPref
  wrap: boolean
  layout: Node
  projectsCollapsed: boolean
  /** Graph: also draw the other local branches, and optionally remote ones. */
  otherBranches: boolean
  remoteBranches: boolean
  /** Look for a new release at launch and every few hours, and install it. */
  autoUpdate: boolean
  /** Groups folded in the projects list. */
  collapsedGroups: string[]
  /** Icons in the changes and files lists. */
  fileIcons: FileIconTheme
}

export type FileIconTheme = "minimal" | "outline" | "color" | "letters"

// v2: the layout became a tree and diff lines stopped wrapping by default.
// v3: the default layout changed (two columns) and presets went away; v2 keeps everything but the layout.
const PREFS_KEY = "retrace.ui.v3"
const OLD_PREFS_KEY = "retrace.ui.v2"
const defaults: Prefs = {
  diffStyle: "split",
  diffView: "file",
  listMode: "tree",
  changesMode: "changes",
  rendered: true,
  commitBody: true,
  language: "system",
  wrap: false,
  layout: DEFAULT_LAYOUT,
  projectsCollapsed: false,
  otherBranches: false,
  remoteBranches: false,
  autoUpdate: true,
  collapsedGroups: [],
  fileIcons: "color",
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const stored = raw ? JSON.parse(raw) : { ...JSON.parse(localStorage.getItem(OLD_PREFS_KEY) ?? "{}"), layout: undefined }
    const saved = { ...defaults, ...stored }
    return isValid(saved.layout) ? saved : { ...saved, layout: DEFAULT_LAYOUT }
  } catch {
    return defaults
  }
}

export const prefs = createStore<Prefs>(loadPrefs())
prefs.subscribe(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.get())))

const LAST_PROJECT = "retrace.project"
export const ui = createStore<UiState>({
  projectId: localStorage.getItem(LAST_PROJECT),
  tabs: {},
  branchTabs: {},
  selection: null,
  file: null,
  jump: 0,
  fileOrder: [],
  query: "",
  focusArea: "graph",
  focusMode: false,
  diffOpen: false,
  preview: null,
  historyFile: null,
  settingsOpen: false,
  adding: null,
  fetching: false,
})
ui.subscribe(() => {
  const id = ui.get().projectId
  if (id) localStorage.setItem(LAST_PROJECT, id)
})

export function selectionKey(s: Selection | null): string {
  if (!s) return ""
  return s.kind === "commit" ? s.hash : s.kind
}
