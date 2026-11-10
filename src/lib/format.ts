import { lang } from "./i18n"

/** "35 分钟" / "35m", "2 小时" / "2h", "3 天" / "3d" … — short, for single-line rows. */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const zh = lang() === "zh"
  const minutes = Math.max(0, Math.round((now / 1000 - unixSeconds) / 60))
  if (minutes < 1) return zh ? "刚刚" : "now"
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时` : `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return zh ? `${days} 天` : `${days}d`
  const months = Math.round(days / 30)
  if (months < 12) return zh ? `${months} 个月` : `${months}mo`
  const years = Math.round(days / 365)
  return zh ? `${years} 年` : `${years}y`
}

/** "3 天前" / "3d ago", "刚刚" / "just now". */
export function ago(unixSeconds: number, now = Date.now()): string {
  const zh = lang() === "zh"
  if (now / 1000 - unixSeconds < 60) return zh ? "刚刚" : "just now"
  return zh ? `${relativeTime(unixSeconds, now)}前` : `${relativeTime(unixSeconds, now)} ago`
}

/** "11月4日 14:25" / "Nov 4, 14:25"; the year only when it isn't this year. */
export function absoluteTime(unixSeconds: number, now = new Date()): string {
  const d = new Date(unixSeconds * 1000)
  const sameYear = d.getFullYear() === now.getFullYear()
  if (lang() === "en") {
    return d.toLocaleString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
  }
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`
}

/** How long a check ran: "38s", "1m 38s", "1h 2m" (Chinese: "38 秒", "1 分 38 秒", "1 小时 2 分"). */
export function duration(seconds: number): string {
  const zh = lang() === "zh"
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return zh ? `${h} 小时 ${m} 分` : `${h}h ${m}m`
  if (m) return zh ? `${m} 分 ${sec} 秒` : `${m}m ${sec}s`
  return zh ? `${sec} 秒` : `${sec}s`
}

export const shortHash = (hash: string) => hash.slice(0, 7)

/** "~/Code/foo" for paths under the home folder. */
export function tildify(path: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(path)
  return m ? `~${m[1] ?? ""}` : path
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
