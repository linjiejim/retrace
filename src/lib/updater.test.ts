import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { check, notify } = vi.hoisted(() => ({
  check: vi.fn(),
  notify: { success: vi.fn(), info: vi.fn(), error: vi.fn(), prompt: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))
vi.mock("./api", () => ({ inTauri: true }))
vi.mock("./i18n", () => ({ t: (s: string) => s }))
vi.mock("./store", () => ({ prefs: { get: () => ({ autoUpdate: true }) } }))
vi.mock("@/components/ui/toast", () => ({ notify }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check }))
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.5.0" }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}
const release = (version: string, install: () => Promise<void> = async () => {}) => ({ version, downloadAndInstall: vi.fn(install) })

// The updater keeps its state in the module: each test gets a fresh copy.
const load = () => import("./updater")

describe("updater", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.stubEnv("DEV", false)
    notify.loading.mockReturnValue("progress")
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => vi.unstubAllEnvs())

  it("says nothing when an automatic check finds no update, and says so when asked", async () => {
    const { checkForUpdates } = await load()
    check.mockResolvedValue(null)
    await checkForUpdates(false)
    expect(notify.success).not.toHaveBeenCalled()
    await checkForUpdates(true)
    expect(notify.success).toHaveBeenCalledTimes(1)
  })

  it("lets a manual check join a running automatic one and shows its error", async () => {
    const { checkForUpdates } = await load()
    const pending = deferred<null>()
    check.mockReturnValueOnce(pending.promise)
    const automatic = checkForUpdates(false)
    const manual = checkForUpdates(true)
    expect(manual).toBe(automatic)
    pending.reject(new Error("offline"))
    await manual
    expect(check).toHaveBeenCalledTimes(1)
    expect(notify.error).toHaveBeenCalledTimes(1)
  })

  it("keeps an automatic failure quiet", async () => {
    const { checkForUpdates } = await load()
    check.mockRejectedValue(new Error("offline"))
    await checkForUpdates(false)
    expect(notify.error).not.toHaveBeenCalled()
  })

  it("tries again after a failed install", async () => {
    const { checkForUpdates } = await load()
    check.mockResolvedValueOnce(release("0.5.1", async () => Promise.reject(new Error("disk full"))))
    await checkForUpdates(false)
    expect(notify.prompt).not.toHaveBeenCalled()
    check.mockResolvedValueOnce(release("0.5.1"))
    await checkForUpdates(false)
    expect(check).toHaveBeenCalledTimes(2)
    expect(notify.prompt).toHaveBeenCalledTimes(1)
  })

  it("downloads nothing more once installed, and asking again shows the same restart prompt", async () => {
    const { checkForUpdates } = await load()
    check.mockResolvedValue(release("0.5.1"))
    await checkForUpdates(false)
    await checkForUpdates(false)
    await checkForUpdates(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(notify.prompt).toHaveBeenCalledTimes(2)
    expect(notify.prompt.mock.calls[1][0]).toBe(notify.prompt.mock.calls[0][0])
  })

  it("shows a download already under way to a manual check, then clears it", async () => {
    const { checkForUpdates } = await load()
    const install = deferred<void>()
    const found = release("0.5.1", () => install.promise)
    check.mockResolvedValue(found)
    const automatic = checkForUpdates(false)
    await vi.waitFor(() => expect(found.downloadAndInstall).toHaveBeenCalled())
    expect(notify.loading).not.toHaveBeenCalled()
    void checkForUpdates(true)
    expect(notify.loading).toHaveBeenCalledTimes(1)
    install.resolve()
    await automatic
    expect(notify.dismiss).toHaveBeenCalledWith("progress")
    expect(notify.prompt).toHaveBeenCalledTimes(1)
  })

  it("checks nothing in `pnpm tauri dev`", async () => {
    vi.stubEnv("DEV", true)
    const { checkForUpdates, scheduleUpdateChecks } = await load()
    await checkForUpdates(true)
    scheduleUpdateChecks()()
    expect(check).not.toHaveBeenCalled()
    expect(notify.info).toHaveBeenCalledTimes(1)
  })
})
