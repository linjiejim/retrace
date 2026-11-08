"use client"

/**
 * Appearance preference: system | light | dark.
 * Store the preference itself, never the resolved value, so "system" keeps
 * following the OS. Pages never read the OS appearance on their own.
 *
 * Avoid a flash on load by inlining APPEARANCE_BOOT_SCRIPT in <head>.
 */
import { useCallback, useSyncExternalStore } from "react"

export type Appearance = "system" | "light" | "dark"

const KEY = "appearance"
const media = () => window.matchMedia("(prefers-color-scheme: dark)")

export function getAppearance(): Appearance {
  const v = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

export function resolveAppearance(pref: Appearance): "light" | "dark" {
  if (pref !== "system") return pref
  return typeof window !== "undefined" && media().matches ? "dark" : "light"
}

function apply(pref: Appearance) {
  document.documentElement.classList.toggle("dark", resolveAppearance(pref) === "dark")
}

const listeners = new Set<() => void>()

export function setAppearance(pref: Appearance) {
  if (pref === "system") localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, pref)
  apply(pref)
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  const onOs = () => {
    if (getAppearance() === "system") apply("system")
    cb()
  }
  const m = media()
  m.addEventListener("change", onOs)
  return () => {
    listeners.delete(cb)
    m.removeEventListener("change", onOs)
  }
}

export function useAppearance() {
  const preference = useSyncExternalStore(subscribe, getAppearance, () => "system" as Appearance)
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolveAppearance(getAppearance()),
    () => "light" as const,
  )
  const set = useCallback((p: Appearance) => setAppearance(p), [])
  return { preference, resolved, setAppearance: set }
}

export const APPEARANCE_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem("${KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`
