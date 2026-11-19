// The macOS menu bar. Settings and view options live here instead of on the page; check marks
// follow the stores both ways.

import { api, inTauri } from "./api"
import { run, selectProject, type CommandId } from "./commands"
import { PINNED, sections } from "./groups"
import { t } from "./i18n"
import { queryClient } from "./query"
import { prefs, ui, type Prefs, type UiState } from "./store"
import type { Group, Project } from "./types"

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
  toggleFoldMerges: (p) => p.foldMerges,
  toggleFoldBranches: (p) => p.otherBranches && p.foldBranches,
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
          await check("toggleFoldBranches", "Fold Each Branch into One Row"),
          await check("toggleFoldMerges", "Fold Merged Commits"),
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

  // The menu bar icon (top right, created by the backend) drops down every project, by group like
  // the projects list: pick one to bring the window up with it open. Rebuilt when projects or groups change.
  const { TrayIcon } = await import("@tauri-apps/api/tray")
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const tray = await TrayIcon.getById("projects")
  const showWindow = async () => {
    const w = getCurrentWindow()
    await w.unminimize().catch(() => {})
    await w.show().catch(() => {})
    await w.setFocus().catch(() => {})
  }
  const projectChecks = new Map<string, Awaited<ReturnType<typeof CheckMenuItem.new>>>()
  let checkedProject: string | null | undefined
  const syncProject = () => {
    const current = ui.get().projectId
    if (current === checkedProject) return
    checkedProject = current
    for (const [id, c] of projectChecks) c.setChecked(id === current).catch(() => {})
  }
  let listedKey = ""
  let listing = Promise.resolve()
  const listProjects = () =>
    (listing = listing
      .then(async () => {
        if (!tray) return
        const [projects, groups] = await Promise.all([
          queryClient.fetchQuery<Project[]>({ queryKey: ["projects"], queryFn: api.listProjects, staleTime: Infinity }),
          queryClient.fetchQuery<Group[]>({ queryKey: ["groups"], queryFn: api.listGroups, staleTime: Infinity }),
        ])
        const key = JSON.stringify([projects.map((p) => [p.id, p.name, p.group, p.pinned]), groups.map((g) => [g.id, g.name])])
        if (mine !== generation || key === listedKey) return
        const byId = new Map(projects.map((p) => [p.id, p]))
        const groupName = new Map(groups.map((g) => [g.id, g.name]))
        const current = ui.get().projectId
        const checks = new Map<string, Awaited<ReturnType<typeof CheckMenuItem.new>>>()
        const items = []
        for (const section of sections(projects, groups)) {
          if (!section.ids.length) continue
          if (items.length) items.push(await sep())
          const label = section.group === PINNED ? t("Pinned") : section.group ? groupName.get(section.group) : null
          if (label) items.push(await MenuItem.new({ text: label, enabled: false }))
          for (const id of section.ids) {
            const c = await CheckMenuItem.new({
              text: byId.get(id)!.name,
              checked: id === current,
              action: () => {
                if (ui.get().projectId !== id) selectProject(id)
                // The click flipped the native mark itself: put every mark back where it belongs.
                checkedProject = undefined
                syncProject()
                void showWindow()
              },
            })
            checks.set(id, c)
            items.push(c)
          }
        }
        if (items.length) items.push(await sep())
        items.push(
          // Closing the window only hides it (see lib.rs): this brings it back as it was.
          await MenuItem.new({ text: t("Open Retrace"), action: () => void showWindow() }),
          await MenuItem.new({
            text: t("Add Project…"),
            action: () => showWindow().then(() => run("addProject")),
          }),
          await sys("Quit", "Quit Retrace"),
        )
        const trayMenu = await Menu.new({ items })
        if (mine !== generation) return
        await tray.setMenu(trayMenu)
        listedKey = key
        projectChecks.clear()
        for (const [id, c] of checks) projectChecks.set(id, c)
        checkedProject = current
        syncProject()
      })
      .catch((e) => console.error("tray", e)))
  listProjects()
  const offQueries = queryClient.getQueryCache().subscribe((e) => {
    const k = e.query.queryKey[0]
    if (e.type === "updated" && e.action.type === "success" && (k === "projects" || k === "groups")) listProjects()
  })

  sync()
  const offPrefs = prefs.subscribe(sync)
  const offUi = ui.subscribe(() => {
    sync()
    syncProject()
  })
  return () => {
    offPrefs()
    offUi()
    offQueries()
  }
}
