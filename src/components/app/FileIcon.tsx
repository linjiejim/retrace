import type { LucideIcon } from "lucide-react"
import {
  Atom,
  Binary,
  BookOpen,
  Braces,
  CodeXml,
  Container,
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Film,
  FlaskConical,
  Folder,
  FolderArchive,
  FolderCheck,
  FolderCode,
  FolderCog,
  FolderHeart,
  FolderOpen,
  GitBranch,
  Hash,
  KeyRound,
  Package,
  Scale,
  Type,
} from "lucide-react"
import { fileType, folderType, type FileKind, type FolderKind, type Tone } from "@/lib/file-icons"
import type { FileIconTheme } from "@/lib/store"
import { cn } from "@/lib/utils"

const FILE_ICON: Record<FileKind, LucideIcon> = {
  code: FileCode,
  react: Atom,
  json: Braces,
  markup: CodeXml,
  style: Hash,
  doc: FileText,
  readme: BookOpen,
  image: FileImage,
  video: Film,
  audio: FileMusic,
  shell: FileTerminal,
  config: FileCog,
  env: KeyRound,
  lock: FileLock,
  archive: FileArchive,
  data: Database,
  sheet: FileSpreadsheet,
  font: Type,
  docker: Container,
  git: GitBranch,
  license: Scale,
  package: Package,
  test: FlaskConical,
  binary: Binary,
  file: File,
}

const FOLDER_ICON: Record<FolderKind, LucideIcon> = {
  code: FolderCode,
  test: FolderCheck,
  docs: Folder,
  config: FolderCog,
  assets: FolderHeart,
  deps: FolderArchive,
  folder: Folder,
}

const color = (tone: Tone) => (tone === "faint" ? undefined : { color: `var(--${tone})` })

/** The icon before a file name in the changes and files lists, in the chosen theme. */
export function FileIcon({ path, theme, className }: { path: string; theme: FileIconTheme; className?: string }) {
  const base = cn("size-3.5 shrink-0", className)
  if (theme === "minimal") return <File className={cn(base, "text-faint-foreground")} />
  const type = fileType(path)
  if (theme === "letters") {
    if (!type.letters) return <File className={cn(base, "text-faint-foreground")} />
    return (
      <span
        aria-hidden
        className={cn("inline-flex h-3.5 w-4 shrink-0 items-center justify-center font-mono text-caption leading-none font-bold tracking-tighter", type.tone === "faint" && "text-faint-foreground", className)}
        style={color(type.tone)}
      >
        {type.letters}
      </span>
    )
  }
  const Icon = FILE_ICON[type.kind]
  if (theme === "outline") return <Icon className={cn(base, "text-muted-foreground")} />
  return <Icon className={cn(base, type.tone === "faint" && "text-faint-foreground")} style={color(type.tone)} />
}

export function FolderIcon({ name, open, theme, className }: { name: string; open: boolean; theme: FileIconTheme; className?: string }) {
  const base = cn("size-3.5 shrink-0", className)
  if (theme === "minimal") return <Folder className={cn(base, "text-faint-foreground")} />
  if (theme === "outline" || theme === "letters") {
    const Icon = open ? FolderOpen : Folder
    return <Icon className={cn(base, "text-muted-foreground")} />
  }
  const type = folderType(name)
  const Icon = open ? FolderOpen : FOLDER_ICON[type.kind]
  return <Icon className={cn(base, type.tone === "faint" && "text-faint-foreground")} style={color(type.tone)} />
}
