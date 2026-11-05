/** "35 分钟" / "2 小时" / "3 天" / "4 个月" / "2 年" — short, for single-line rows. */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now / 1000 - unixSeconds) / 60))
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} 个月`
  return `${Math.round(days / 365)} 年`
}

/** "2026年11月4日 14:25" (adds the year only when it isn't this year). */
export function absoluteTime(unixSeconds: number, now = new Date()): string {
  const d = new Date(unixSeconds * 1000)
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`
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
