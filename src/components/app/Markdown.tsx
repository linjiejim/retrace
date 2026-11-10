// Loaded lazily: the Markdown parser only comes in when a Markdown file is previewed.
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import { openLink, openPreview } from "@/lib/commands"
import { resolvePath } from "@/lib/filetype"
import { t } from "@/lib/i18n"
import type { Target } from "@/lib/types"
import { useFileContent } from "@/hooks/queries"

const EXTERNAL = /^(https?:|mailto:)/i
/** `//host/path` is a web link too (protocol-relative). */
const web = (href: string) => (href.startsWith("//") ? `https:${href}` : href)

/**
 * Inline HTML is common in READMEs (`<p align="center"><img …>`): it is parsed, then cleaned with
 * GitHub's own allow-list, so no scripts, styles or event handlers survive.
 */
const schema = {
  ...defaultSchema,
  // <picture><source srcset> would let the browser fetch a remote image instead of the repository's.
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "source" && tag !== "picture"),
  attributes: { ...defaultSchema.attributes, "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"] },
}
/** `compact`: inline in a card (a pull request's description), without the page's own scroller and margins. */
export default function Markdown({ text, path, projectId, target, compact }: { text: string; path: string; projectId: string; target: Target; compact?: boolean }) {
  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (!href) return
          // Web links go to the browser; links into the repository open here.
          if (EXTERNAL.test(web(href))) return openLink(web(href))
          const to = resolvePath(path, href)
          if (to) openPreview(to)
        }}
      >
        {children}
      </a>
    ),
    img: ({ src, alt, width, height }) => <RepoImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} size={{ width, height }} from={path} projectId={projectId} target={target} />,
  }
  const body = (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]} components={components}>
      {text}
    </ReactMarkdown>
  )
  if (compact) return <article className="markdown max-w-[860px]">{body}</article>
  return (
    <div className="selectable h-full overflow-y-auto">
      <article className="markdown mx-auto max-w-[860px] px-8 py-6">{body}</article>
    </div>
  )
}

/** Images next to the Markdown file come from the same version; remote ones aren't fetched. */
function RepoImage({
  src,
  alt,
  size,
  from,
  projectId,
  target,
}: {
  src: string
  alt: string
  size: { width?: number | string; height?: number | string }
  from: string
  projectId: string
  target: Target
}) {
  const local = !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//") ? resolvePath(from, src) : null
  const content = useFileContent(projectId, target, local)
  if (src.startsWith("data:image/")) return <img src={src} alt={alt} {...size} />
  const c = content.data
  if (local && c?.data && c.mime) return <img src={`data:${c.mime};base64,${c.data}`} alt={alt} {...size} />
  return <span className="md-missing-image">{alt || t("Image")}</span>
}
