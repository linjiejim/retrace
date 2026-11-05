import { useQueryClient } from "@tanstack/react-query"
import { AppWindow, FolderGit2, LayoutPanelLeft, Palette } from "lucide-react"
import { api } from "@/lib/api"
import { useAppearance, type Appearance } from "@/lib/appearance"
import { run } from "@/lib/commands"
import { t, type LangPref } from "@/lib/i18n"
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
const fetchOptions = () => [
  { value: "0", label: t("Off") },
  { value: "5", label: t("Every {n} minutes", { n: 5 }) },
  { value: "10", label: t("Every {n} minutes", { n: 10 }) },
  { value: "30", label: t("Every {n} minutes", { n: 30 }) },
]

const withCurrent = (list: string[], current: string | undefined) =>
  (current && !list.includes(current) ? [current, ...list] : list).map((v) => ({ value: v, label: v }))

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const { preference, setAppearance } = useAppearance()
  const server = usePrefs()
  const diffStyle = useStore(uiPrefs, (s) => s.diffStyle)
  const wrap = useStore(uiPrefs, (s) => s.wrap)
  const language = useStore(uiPrefs, (s) => s.language)

  const save = async (patch: Partial<Prefs>) => {
    if (!server.data) return
    const next = { ...server.data, ...patch }
    qc.setQueryData(["prefs"], next)
    try {
      await api.setPrefs(next)
    } catch (e) {
      qc.setQueryData(["prefs"], server.data)
      notify.error(t("Couldn't save the settings: {reason}", { reason: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={t("Settings")} />
        <DialogBody className="pb-5">
          <SettingsSection variant="grouped" icon={<Palette />} title={t("Appearance")}>
            <SettingRow
              label={t("Language")}
              control={
                <Segmented<LangPref>
                  size="sm"
                  value={language}
                  onValueChange={(v) => uiPrefs.set({ language: v })}
                  options={[
                    { value: "system", label: t("System") },
                    { value: "zh", label: "中文" }, // i18n-allow: each language is named in itself
                    { value: "en", label: "English" },
                  ]}
                />
              }
            />
            <SettingRow
              label={t("Theme")}
              control={
                <Segmented<Appearance>
                  size="sm"
                  value={preference}
                  onValueChange={setAppearance}
                  options={[
                    { value: "system", label: t("System") },
                    { value: "light", label: t("Light") },
                    { value: "dark", label: t("Dark") },
                  ]}
                />
              }
            />
            <SettingRow
              label={t("Diff layout")}
              control={
                <Segmented
                  size="sm"
                  value={diffStyle}
                  onValueChange={(v) => uiPrefs.set({ diffStyle: v })}
                  options={[
                    { value: "split", label: t("Side by side") },
                    { value: "unified", label: t("Unified") },
                  ]}
                />
              }
            />
            <SettingRow label={t("Wrap diff lines")} control={<Switch checked={wrap} onCheckedChange={(v) => uiPrefs.set({ wrap: v })} />} />
          </SettingsSection>
          <SettingsSection variant="grouped" icon={<LayoutPanelLeft />} title={t("Layout")}>
            <SettingRow
              label={t("Restore default layout")}
              description={t("Projects and changes on the left, the graph and diff on the right; the diff stays closed until you click a commit.")}
              control={
                <Button
                  size="sm"
                  onClick={() => {
                    run("resetLayout")
                    notify.success(t("Default layout restored"))
                  }}
                >
                  {t("Restore")}
                </Button>
              }
            />
          </SettingsSection>
          <SettingsSection variant="grouped" icon={<FolderGit2 />} title={t("Repositories")}>
            <SettingRow
              label={t("Fetch from remotes automatically")}
              description={t("Download only, never merge: keeps ahead / behind and “Merged” accurate.")}
              control={
                <Select
                  className="w-36"
                  options={fetchOptions()}
                  value={String(server.data?.fetchMinutes ?? 10)}
                  onValueChange={(v) => save({ fetchMinutes: Number(v) })}
                  disabled={!server.data}
                />
              }
            />
          </SettingsSection>
          <SettingsSection variant="grouped" icon={<AppWindow />} title={t("Open with")}>
            <SettingRow
              label={t("Editor")}
              control={<Select className="w-48" options={withCurrent(EDITORS, server.data?.editor)} value={server.data?.editor} onValueChange={(v) => save({ editor: v })} disabled={!server.data} />}
            />
            <SettingRow
              label={t("Terminal")}
              control={<Select className="w-48" options={withCurrent(TERMINALS, server.data?.terminal)} value={server.data?.terminal} onValueChange={(v) => save({ terminal: v })} disabled={!server.data} />}
            />
            <SettingRow
              label={t("Browser")}
              description={t("For pull requests on GitHub and web links in documents.")}
              control={
                <Select
                  className="w-48"
                  options={[{ value: SYSTEM_BROWSER, label: t("System default browser") }, ...withCurrent(BROWSERS, server.data?.browser || undefined)]}
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
