import { useQueryClient } from "@tanstack/react-query"
import { AppWindow, FolderGit2, LayoutPanelLeft, Palette } from "lucide-react"
import { api } from "@/lib/api"
import { useAppearance, type Appearance } from "@/lib/appearance"
import { run } from "@/lib/commands"
import { prefs as uiPrefs, useStore } from "@/lib/store"
import type { Prefs } from "@/lib/types"
import { usePrefs } from "@/hooks/queries"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog"
import { Segmented } from "@/components/ui/segmented"
import { Select } from "@/components/ui/select"
import { SettingRow, SettingsSection } from "@/components/ui/settings"
import { Switch } from "@/components/ui/switch"
import { notify } from "@/components/ui/toast"

const EDITORS = ["Visual Studio Code", "Cursor", "Zed", "Sublime Text", "Xcode", "Nova"]
const TERMINALS = ["Terminal", "iTerm", "Ghostty", "Warp", "WezTerm", "kitty"]
/** "" in the config; Select items can't carry an empty value. */
const SYSTEM_BROWSER = "system"
const BROWSERS = ["Safari", "Google Chrome", "Arc", "Firefox", "Microsoft Edge", "Brave Browser", "Orion"]
const FETCH = [
  { value: "0", label: "关闭" },
  { value: "5", label: "每 5 分钟" },
  { value: "10", label: "每 10 分钟" },
  { value: "30", label: "每 30 分钟" },
]

const withCurrent = (list: string[], current: string | undefined) =>
  (current && !list.includes(current) ? [current, ...list] : list).map((v) => ({ value: v, label: v }))

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const { preference, setAppearance } = useAppearance()
  const server = usePrefs()
  const diffStyle = useStore(uiPrefs, (s) => s.diffStyle)
  const wrap = useStore(uiPrefs, (s) => s.wrap)

  const save = async (patch: Partial<Prefs>) => {
    if (!server.data) return
    const next = { ...server.data, ...patch }
    qc.setQueryData(["prefs"], next)
    try {
      await api.setPrefs(next)
    } catch (e) {
      qc.setQueryData(["prefs"], server.data)
      notify.error(`没能保存设置：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="设置" />
        <DialogBody className="pb-5">
          <SettingsSection variant="grouped" icon={<Palette />} title="外观">
            <SettingRow
              label="主题"
              control={
                <Segmented<Appearance>
                  size="sm"
                  value={preference}
                  onValueChange={setAppearance}
                  options={[
                    { value: "system", label: "跟随系统" },
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                  ]}
                />
              }
            />
            <SettingRow
              label="diff 布局"
              control={
                <Segmented
                  size="sm"
                  value={diffStyle}
                  onValueChange={(v) => uiPrefs.set({ diffStyle: v })}
                  options={[
                    { value: "split", label: "并排" },
                    { value: "unified", label: "合并" },
                  ]}
                />
              }
            />
            <SettingRow label="diff 自动换行" control={<Switch checked={wrap} onCheckedChange={(v) => uiPrefs.set({ wrap: v })} />} />
          </SettingsSection>
          <SettingsSection variant="grouped" icon={<LayoutPanelLeft />} title="布局">
            <SettingRow
              label="恢复默认布局"
              description="左列项目和改动，右列提交图和 diff；diff 先关着，点提交再打开。"
              control={
                <Button
                  size="sm"
                  onClick={() => {
                    run("resetLayout")
                    notify.success("已恢复默认布局")
                  }}
                >
                  恢复默认
                </Button>
              }
            />
          </SettingsSection>
          <SettingsSection variant="grouped" icon={<FolderGit2 />} title="仓库">
            <SettingRow
              label="自动获取远程更新"
              description="只下载，不合并，让领先 / 落后和「已合并」保持准确。"
              control={
                <Select
                  className="w-36"
                  options={FETCH}
                  value={String(server.data?.fetchMinutes ?? 10)}
                  onValueChange={(v) => save({ fetchMinutes: Number(v) })}
                  disabled={!server.data}
                />
              }
            />
          </SettingsSection>
          <SettingsSection variant="grouped" icon={<AppWindow />} title="打开方式">
            <SettingRow
              label="编辑器"
              control={<Select className="w-48" options={withCurrent(EDITORS, server.data?.editor)} value={server.data?.editor} onValueChange={(v) => save({ editor: v })} disabled={!server.data} />}
            />
            <SettingRow
              label="终端"
              control={<Select className="w-48" options={withCurrent(TERMINALS, server.data?.terminal)} value={server.data?.terminal} onValueChange={(v) => save({ terminal: v })} disabled={!server.data} />}
            />
            <SettingRow
              label="浏览器"
              description="打开 GitHub 上的 PR 和文档里的网页链接。"
              control={
                <Select
                  className="w-48"
                  options={[{ value: SYSTEM_BROWSER, label: "系统默认浏览器" }, ...withCurrent(BROWSERS, server.data?.browser || undefined)]}
                  value={server.data ? server.data.browser || SYSTEM_BROWSER : undefined}
                  onValueChange={(v) => save({ browser: v === SYSTEM_BROWSER ? "" : v })}
                  disabled={!server.data}
                />
              }
            />
          </SettingsSection>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
