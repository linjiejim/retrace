// The macOS menu bar. Settings and view options live here instead of on the page; check marks
// follow the stores both ways.

import { inTauri } from "./api"
import { run, type CommandId } from "./commands"
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

/** Builds the menu bar once; returns a function that stops syncing check marks. */
export async function installMenu(): Promise<() => void> {
  if (!inTauri) return () => {}
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
    PredefinedMenuItem.new({ item, text })
  const item = (id: CommandId, text: string, accelerator?: string) => MenuItem.new({ id, text, accelerator, action: () => run(id) })
  const check = async (id: CommandId, text: string, accelerator?: string) => {
    const [p, u] = state()
    const on = CHECKS[id]!(p, u)
    const c = await CheckMenuItem.new({
      id,
      text,
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
    text: "窗口",
    items: [await sys("Minimize", "最小化"), await sys("Maximize", "缩放"), await sep(), await sys("CloseWindow", "关闭窗口")],
  })
  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Retrace",
        items: [
          await PredefinedMenuItem.new({ item: { About: { name: "Retrace", version } }, text: "关于 Retrace" }),
          await sep(),
          await item("settings", "设置…", "CmdOrCtrl+,"),
          await sep(),
          await sys("Services", "服务"),
          await sep(),
          await sys("Hide", "隐藏 Retrace"),
          await sys("HideOthers", "隐藏其他"),
          await sys("ShowAll", "全部显示"),
          await sep(),
          await sys("Quit", "退出 Retrace"),
        ],
      }),
      await Submenu.new({
        text: "项目",
        items: [
          await item("addProject", "添加项目…", "CmdOrCtrl+O"),
          await sep(),
          await item("refresh", "刷新并从远程获取", "CmdOrCtrl+R"),
          await sep(),
          await item("revealInFinder", "在 Finder 中显示", "CmdOrCtrl+Shift+F"),
          await item("openInTerminal", "在终端打开", "Control+`"),
          await item("openInEditor", "在编辑器打开", "CmdOrCtrl+Shift+A"),
        ],
      }),
      await Submenu.new({
        text: "编辑",
        items: [
          await sys("Undo", "撤销"),
          await sys("Redo", "重做"),
          await sep(),
          await sys("Cut", "剪切"),
          await sys("Copy", "拷贝"),
          await sys("Paste", "粘贴"),
          await sys("SelectAll", "全选"),
          await sep(),
          await item("find", "筛选提交…", "CmdOrCtrl+F"),
        ],
      }),
      await Submenu.new({
        text: "视图",
        items: [
          await check("toggleProjects", "显示项目栏", "CmdOrCtrl+\\"),
          await check("toggleDiff", "显示 diff", "CmdOrCtrl+J"),
          await check("toggleFocus", "专注：只看改动和 diff（F）"),
          await sep(),
          await check("toggleSplit", "并排显示 diff"),
          await check("toggleWrap", "自动换行"),
          await check("toggleContinuous", "连续阅读全部文件"),
          await sep(),
          await check("toggleOtherBranches", "提交图显示其他分支"),
          await check("toggleRemotes", "包括远程分支"),
          await sep(),
          await item("resetLayout", "恢复默认布局"),
          await sep(),
          await sys("Fullscreen", "进入全屏"),
        ],
      }),
      windowMenu,
    ],
  })
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
