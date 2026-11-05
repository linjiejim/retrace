/** Kept in step with `image_mime` in src-tauri/src/core/files.rs. */
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i

export const isImage = (path: string) => IMAGE.test(path)
export const isSvg = (path: string) => /\.svg$/i.test(path)
export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

/** Folder of a repository path, and a relative link resolved against it (`null` if it leaves the repository). */
export function resolvePath(from: string, href: string): string | null {
  const clean = href.split(/[?#]/)[0]
  if (!clean) return null
  // A leading slash means the repository root, as on GitHub.
  const parts = clean.startsWith("/") ? [] : from.split("/").slice(0, -1)
  for (const seg of clean.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (!parts.length) return null
      parts.pop()
    } else {
      try {
        parts.push(decodeURIComponent(seg))
      } catch {
        parts.push(seg)
      }
    }
  }
  return parts.length ? parts.join("/") : null
}
