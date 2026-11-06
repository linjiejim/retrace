// Updates come straight from GitHub Releases: the app reads `latest.json` from the latest
// published release (a draft doesn't count), downloads that release's `.app.tar.gz`, checks it
// against the public key in tauri.conf.json, swaps itself in place and asks for a restart.

import { inTauri } from "./api"
import { t } from "./i18n"
import { prefs } from "./store"
import { notify } from "@/components/ui/toast"

/** The first automatic check waits for the app to settle; then one every few hours. */
const FIRST_CHECK = 10_000
const EVERY = 6 * 60 * 60 * 1000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A version already installed on disk, waiting for a restart. */
let installed: string | null = null
let running: Promise<void> | null = null
/** Someone asked (the menu, Settings): show every outcome, not only a finished update. */
let asked = false

function offerRestart(version: string) {
  notify.prompt(t("Retrace {version} is installed. Restart to use it.", { version }), {
    label: t("Restart"),
    onClick: () => void import("@tauri-apps/plugin-process").then((p) => p.relaunch()),
  })
}

async function update() {
  const [{ check }, { getVersion }] = await Promise.all([import("@tauri-apps/plugin-updater"), import("@tauri-apps/api/app")])
  const found = await check({ timeout: 30_000 })
  if (!found) {
    if (asked) notify.success(t("Retrace {version} is the latest version", { version: await getVersion() }))
    return
  }
  const progress = asked ? notify.loading(t("Downloading Retrace {version}…", { version: found.version })) : undefined
  try {
    await found.downloadAndInstall()
  } finally {
    if (progress !== undefined) notify.dismiss(progress)
  }
  installed = found.version
  offerRestart(found.version)
}

/** `manual`: the user asked, so "up to date" and errors are shown too; automatic checks stay quiet. */
export function checkForUpdates(manual: boolean): Promise<void> {
  // `pnpm tauri dev` runs a bare binary, not an app bundle that could be replaced.
  if (!inTauri || import.meta.env.DEV) {
    if (manual) notify.info(t("Updates work in the installed app only"))
    return Promise.resolve()
  }
  if (installed) {
    if (manual) offerRestart(installed)
    return Promise.resolve()
  }
  if (manual) asked = true
  running ??= update()
    .catch((e) => {
      if (asked) notify.error(t("Couldn't update Retrace: {reason}", { reason: message(e) }))
      else console.warn("update", e)
    })
    .finally(() => {
      running = null
      asked = false
    })
  return running
}

/** At launch and every few hours, while the setting is on. Returns a function that stops it. */
export function scheduleUpdateChecks(): () => void {
  if (!inTauri || import.meta.env.DEV) return () => {}
  const tick = () => {
    if (prefs.get().autoUpdate) void checkForUpdates(false)
  }
  const first = setTimeout(tick, FIRST_CHECK)
  const every = setInterval(tick, EVERY)
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
