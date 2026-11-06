// The macOS menu bar. Settings and view options live here instead of on the page; check marks
// follow the stores both ways.

import { inTauri } from "./api"
import { run, type CommandId } from "./commands"
import { t } from "./i18n"
import { prefs, ui, type Prefs, type UiState } from "./store"

type Checked = (p: Prefs, u: UiState) => boolean

const CHECKS: Partial<Record<CommandId, Checked>> = {
  toggleProjects: (p) => !p.projectsCollapsed,
  toggleDiff: (_, u) => u.diffOpen,
  toggleFocus: (_, u) => u.focusMode,
  toggleSplit: (p) => p.diffStyle === "split",
  toggleWrap: (p) => p.wrap,
  toggleContinuous: (p) => p.diffView === "all",
  toggleOtherBranches: (p) => p.otherBranches,
  toggleRemotes: (p) => p.otherBranches && p.remoteBranches,
}

let generation = 0

/**
 * Builds the menu bar in the current language; returns a function that stops syncing check marks.
 * A build overtaken by a newer one (the language changed while it awaited) never installs.
 */
export async function installMenu(): Promise<() => void> {
  if (!inTauri) return () => {}
  const mine = ++generation
  const { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } = await import("@tauri-apps/api/menu")
  const { getVersion } = await import("@tauri-apps/api/app")
  const version = await getVersion()
  const checks = new Map<CommandId, Awaited<ReturnType<typeof CheckMenuItem.new>>>()
  const state = () => [prefs.get(), ui.get()] as const

  // Check marks follow the stores. A click (or shortcut) flips the native mark itself, so after a
  // command the mark is re-applied even when the command changed nothing.
  const shown = new Map<CommandId, boolean>()
  const sync = () => {
    const [p, u] = state()
    for (const [id, c] of checks) {
      const on = CHECKS[id]!(p, u)
      if (shown.get(id) === on) continue
      shown.set(id, on)
      c.setChecked(on).catch(() => {})
    }
  }

  const sep = () => PredefinedMenuItem.new({ item: "Separator" })
  const sys = (item: "Hide" | "HideOthers" | "ShowAll" | "Quit" | "Services" | "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" | "Minimize" | "Maximize" | "Fullscreen" | "CloseWindow", text: string) =>
    PredefinedMenuItem.new({ item, text: t(text) })
  const item = (id: CommandId, text: string, accelerator?: string) => MenuItem.new({ id, text: t(text), accelerator, action: () => run(id) })
  const check = async (id: CommandId, text: string, accelerator?: string) => {
    const [p, u] = state()
    const on = CHECKS[id]!(p, u)
    const c = await CheckMenuItem.new({
      id,
      text: t(text),
      accelerator,
      checked: on,
      action: () => {
        run(id)
        shown.delete(id)
        sync()
      },
    })
    shown.set(id, on)
    checks.set(id, c)
    return c
  }

  const windowMenu = await Submenu.new({
    text: t("Window"),
    items: [await sys("Minimize", "Minimize"), await sys("Maximize", "Zoom"), await sep(), await sys("CloseWindow", "Close Window")],
  })
  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Retrace",
        items: [
          await PredefinedMenuItem.new({ item: { About: { name: "Retrace", version } }, text: t("About Retrace") }),
          await item("checkForUpdates", "Check for Updates…"),
          await sep(),
          await item("settings", "Settings…", "CmdOrCtrl+,"),
          await sep(),
          await sys("Services", "Services"),
          await sep(),
          await sys("Hide", "Hide Retrace"),
          await sys("HideOthers", "Hide Others"),
          await sys("ShowAll", "Show All"),
          await sep(),
          await sys("Quit", "Quit Retrace"),
        ],
      }),
      await Submenu.new({
        text: t("Project"),
        items: [
          await item("addProject", "Add Project…", "CmdOrCtrl+O"),
          await sep(),
          await item("refresh", "Refresh and Fetch", "CmdOrCtrl+R"),
          await sep(),
          await item("revealInFinder", "Show in Finder", "CmdOrCtrl+Shift+F"),
          await item("openInTerminal", "Open in Terminal", "Control+`"),
          await item("openInEditor", "Open in Editor", "CmdOrCtrl+Shift+A"),
          await item("openOnGitHub", "Open on GitHub"),
        ],
      }),
      await Submenu.new({
        text: t("Edit"),
        items: [
          await sys("Undo", "Undo"),
          await sys("Redo", "Redo"),
          await sep(),
          await sys("Cut", "Cut"),
          await sys("Copy", "Copy"),
          await sys("Paste", "Paste"),
          await sys("SelectAll", "Select All"),
          await sep(),
          await item("find", "Filter Commits…", "CmdOrCtrl+F"),
        ],
      }),
      await Submenu.new({
        text: t("View"),
        items: [
          await check("toggleProjects", "Show Projects", "CmdOrCtrl+\\"),
          await check("toggleDiff", "Show Diff", "CmdOrCtrl+J"),
          await check("toggleFocus", "Focus: Changes and Diff Only (F)"),
          await sep(),
          await check("toggleSplit", "Side-by-Side Diff"),
          await check("toggleWrap", "Wrap Lines"),
          await check("toggleContinuous", "Read All Files Continuously"),
          await sep(),
          await check("toggleOtherBranches", "Show Other Branches in Graph"),
          await check("toggleRemotes", "Include Remote Branches"),
          await sep(),
          await item("resetLayout", "Restore Default Layout"),
          await sep(),
          await sys("Fullscreen", "Enter Full Screen"),
        ],
      }),
      windowMenu,
    ],
  })
  if (mine !== generation) return () => {}
  await menu.setAsAppMenu()
  await windowMenu.setAsWindowsMenuForNSApp().catch(() => {})

  sync()
  const offPrefs = prefs.subscribe(sync)
  const offUi = ui.subscribe(sync)
  return () => {
    offPrefs()
    offUi()
  }
}
