"use client"

import * as React from "react"
import { s } from "@/lib/strings"
import { unseenReleases, type Release } from "@/lib/changelog"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog"
import { StateView } from "@/components/ui/state"
import { notify } from "@/components/ui/toast"

/*
 * Updates told to the people using the app: what's new after an update, and a reload prompt on the web.
 * The rules (references/patterns/updates.md):
 *   - useReleaseNotes: the first launch on a newer version says 「已更新到 0.7.6 · 查看更新内容」
 *     once (8s). A first install and a version without notes stay quiet. The dialog lists every
 *     version since the one last seen, newest first.
 *   - ReleaseNotesDialog: opened from that toast or from Settings, never on its own.
 *     「注意」(what the person has to do) sits in a warning Callout; the rest are plain lists.
 *   - useNewVersionPrompt: web apps that deploy continuously. A newer build on the server →
 *     「新版本已发布，刷新后生效 · 刷新页面」, which stays; the page never reloads by itself.
 * Desktop apps with an updater say 「已下载 · 重启」 with notify.prompt themselves.
 * Notes come from the app's own CHANGELOG.md bundled at build time (lib/changelog).
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g

/** **bold**, `code` and [links](…) as their text: notes are read here, not followed. */
function inline(text: string) {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} className="font-medium">{part.slice(2, -2)}</strong>
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={i} className="rounded-sm bg-muted px-1 font-mono text-small">
          {part.slice(1, -1)}
        </code>
      )
    const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(part)
    return link ? link[1] : part
  })
}

/** The notes themselves, newest version first. Also for a Settings or About page. */
export function ReleaseNotes({ releases, className }: { releases: Release[]; className?: string }) {
  if (!releases.length) return <StateView kind="empty" title={s().releaseNotesEmpty} />
  return (
    <div className={className}>
      {releases.map((r) => (
        <section key={r.version} className="border-b py-4 first:pt-0 last:border-b-0 last:pb-0">
          <h3 className="text-heading font-semibold">
            {r.version}
            {r.date && <span className="ml-2 text-small font-normal text-muted-foreground">{s().releaseDate(r.date)}</span>}
          </h3>
          {r.summary && <p className="mt-1 text-body text-muted-foreground">{inline(r.summary)}</p>}
          {r.groups.map((g, i) => {
            const list = (
              <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-faint-foreground">
                {g.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            )
            if (g.kind === "heads-up")
              return (
                <Callout key={i} tone="warning" className="mt-3 text-body">
                  <p className="font-medium">{g.title}</p>
                  <div className="mt-1">{list}</div>
                </Callout>
              )
            return (
              <div key={i} className="mt-3 text-body">
                {g.title && <h4 className="mb-1 text-small font-medium text-muted-foreground">{g.title}</h4>}
                {list}
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/** 「更新内容」. `moreHref`: the full history (GitHub Releases, the site), opened by the app. */
export function ReleaseNotesDialog({
  open,
  onOpenChange,
  releases,
  title = s().whatsNew,
  moreHref,
  onMore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  releases: Release[]
  title?: React.ReactNode
  moreHref?: string
  /** Desktop shells open links themselves (Tauri opener, Electron shell). */
  onMore?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader title={title} />
        <DialogBody className={onMore || moreHref ? undefined : "pb-5"}>
          <ReleaseNotes releases={releases} />
        </DialogBody>
        {(onMore || moreHref) && (
          <DialogFooter className="justify-start border-t pt-3 pb-4">
            {onMore ? (
              <Button variant="link" size="sm" onClick={onMore}>
                {s().allReleaseNotes}
              </Button>
            ) : (
              <Button variant="link" size="sm" asChild>
                <a href={moreHref} target="_blank" rel="noreferrer">
                  {s().allReleaseNotes}
                </a>
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode or storage full: the toast may show again next launch, nothing worse
  }
}

/**
 * After an update, once: 「已更新到 <version> · 查看更新内容」. `version` may arrive late
 * (Tauri's getVersion); nothing happens until it does. Render the dialog with `dialog`;
 * `openAll()` is for 「查看更新内容」 in Settings and shows every release.
 */
export function useReleaseNotes({
  version,
  releases,
  storageKey = "jim:release-notes:seen",
  toast = true,
}: {
  version: string | null | undefined
  releases: Release[]
  storageKey?: string
  /** false: remember the version but don't announce it (an embedded page, a kiosk). */
  toast?: boolean
}) {
  const [shown, setShown] = React.useState<Release[] | null>(null)
  const announced = React.useRef(false)

  React.useEffect(() => {
    if (!version || announced.current) return
    announced.current = true
    const seen = read(storageKey)
    // said once: remember before telling, so a reload or a second window doesn't repeat it
    write(storageKey, version)
    const unseen = unseenReleases(releases, seen, version)
    if (!toast || !unseen.length) return
    notify.info(s().updatedTo(version), { action: { label: s().seeWhatsNew, onClick: () => setShown(unseen) } })
  }, [version, releases, storageKey, toast])

  return {
    openAll: () => setShown(releases),
    dialog: { open: shown !== null, onOpenChange: (open: boolean) => !open && setShown(null), releases: shown ?? [] },
  }
}

/**
 * Web apps that deploy continuously: compare this build with the one on the server and offer a
 * reload. Checks when the tab comes back into view (at most once a minute) and every `every` ms.
 * `current` is what this bundle was built from (a commit or version stamped at build time);
 * `field` names the same value in the JSON at `url`. A failed check stays quiet.
 */
export function useNewVersionPrompt({
  current,
  url = "/version.json",
  field = "commit",
  every = 10 * 60 * 1000,
  onReload = () => window.location.reload(),
}: {
  current: string | null | undefined
  url?: string
  field?: string
  every?: number
  /** Save or flush what must survive the reload first. */
  onReload?: () => void
}) {
  const reload = React.useRef(onReload)
  React.useEffect(() => {
    reload.current = onReload
  })

  React.useEffect(() => {
    if (!current) return
    // one object, not reassigned locals: the checks run async and outlive renders
    const run = { last: 0, found: false, stopped: false }
    const check = async () => {
      if (run.found || run.stopped || Date.now() - run.last < 60_000) return
      run.last = Date.now()
      try {
        const res = await fetch(url, { cache: "no-store" })
        if (!res.ok) return
        const live = (await res.json())?.[field]
        if (run.stopped || typeof live !== "string" || !live || live === current) return
        run.found = true
        notify.prompt("jim:new-version", s().newVersionReady, { label: s().reload, onClick: () => reload.current() })
      } catch {
        // offline, or mid-deploy: try again later
      }
    }
    const onVisible = () => document.visibilityState === "visible" && void check()
    const timer = setInterval(() => void check(), every)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      run.stopped = true
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [current, url, field, every])
}
