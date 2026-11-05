import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { useAppearance, type Appearance } from "@/lib/appearance"
import { prefs as uiPrefs, useStore } from "@/lib/store"
import type { Prefs } from "@/lib/types"
import { usePrefs } from "@/hooks/queries"
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog"
import { Segmented } from "@/components/ui/segmented"
import { Select } from "@/components/ui/select"
import { SettingRow, SettingsSection } from "@/components/ui/settings"
import { notify } from "@/components/ui/toast"

const EDITORS = ["Visual Studio Code", "Cursor", "Zed", "Sublime Text", "Xcode", "Nova"]
const TERMINALS = ["Terminal", "iTerm", "Ghostty", "Warp", "WezTerm", "kitty"]
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
          <SettingsSection title="外观">
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
              label="diff 默认布局"
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
          </SettingsSection>
          <SettingsSection title="仓库">
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
          <SettingsSection title="打开方式">
            <SettingRow
              label="编辑器"
              control={<Select className="w-48" options={withCurrent(EDITORS, server.data?.editor)} value={server.data?.editor} onValueChange={(v) => save({ editor: v })} disabled={!server.data} />}
            />
            <SettingRow
              label="终端"
              control={<Select className="w-48" options={withCurrent(TERMINALS, server.data?.terminal)} value={server.data?.terminal} onValueChange={(v) => save({ terminal: v })} disabled={!server.data} />}
            />
          </SettingsSection>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
