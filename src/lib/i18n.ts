// UI language. Source strings are English and double as keys; `src/locales/zh.ts` maps them to
// Chinese. `{name}` placeholders are filled from `vars`. Changing the language remounts the app
// (see main.tsx), so strings are read at render time and never cached in module constants.

import { zh } from "@/locales/zh"
import { kitEn } from "@/locales/kit-en"
import { configureStrings, s, type Strings } from "./strings"

export type Lang = "zh" | "en"
export type LangPref = "system" | Lang

const kitZh: Strings = { ...s() }
let current: Lang = "zh"

/** The system language: Chinese for any zh-* locale, English otherwise. */
export function systemLang(): Lang {
  const langs = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language]
  return langs.some((l) => l?.toLowerCase().startsWith("zh")) ? "zh" : "en"
}

export function resolveLang(pref: LangPref): Lang {
  return pref === "system" ? systemLang() : pref
}

export function setLang(lang: Lang) {
  current = lang
  configureStrings(lang === "en" ? kitEn : kitZh)
  if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"
}

export const lang = () => current

function fill(text: string, vars?: Record<string, string | number>) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text
}

/** `text` in the current language. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(current === "zh" ? (zh[text] ?? text) : text, vars)
}

/** Counted text: English picks `one` or `other` by `n`; Chinese has one form, keyed by `other`. */
export function tp(one: string, other: string, n: number, vars?: Record<string, string | number>): string {
  const all = { n, ...vars }
  return current === "zh" ? fill(zh[other] ?? other, all) : fill(n === 1 ? one : other, all)
}
