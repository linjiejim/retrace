// Loaded lazily: the Markdown parser only comes in when a Markdown file is previewed.
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { openLink, openPreview } from "@/lib/commands"
import { resolvePath } from "@/lib/filetype"
import type { Target } from "@/lib/types"
import { useFileContent } from "@/hooks/queries"

const EXTERNAL = /^(https?:|mailto:)/i
/** `//host/path` is a web link too (protocol-relative). */
const web = (href: string) => (href.startsWith("//") ? `https:${href}` : href)

/** Raw HTML stays text (react-markdown's default), so a README can't run anything. */
export default function Markdown({ text, path, projectId, target }: { text: string; path: string; projectId: string; target: Target }) {
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
    img: ({ src, alt }) => <RepoImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} from={path} projectId={projectId} target={target} />,
  }
  return (
    <div className="selectable h-full overflow-y-auto">
      <article className="markdown mx-auto max-w-[860px] px-8 py-6">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </article>
    </div>
  )
}

/** Images next to the Markdown file come from the same version; remote ones aren't fetched. */
function RepoImage({ src, alt, from, projectId, target }: { src: string; alt: string; from: string; projectId: string; target: Target }) {
  const local = !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//") ? resolvePath(from, src) : null
  const content = useFileContent(projectId, target, local)
  if (src.startsWith("data:image/")) return <img src={src} alt={alt} />
  const c = content.data
  if (local && c?.data && c.mime) return <img src={`data:${c.mime};base64,${c.data}`} alt={alt} />
  return <span className="md-missing-image">{alt || "图片"}</span>
}
