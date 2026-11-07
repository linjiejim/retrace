// What kind of file a path is, for the icon themes: a shape, a colour and a two-letter tag.
// Colours are the graph's lane tokens, so every theme follows light and dark mode.

export type FileKind =
  | "code"
  | "react"
  | "json"
  | "markup"
  | "style"
  | "doc"
  | "readme"
  | "image"
  | "video"
  | "audio"
  | "shell"
  | "config"
  | "env"
  | "lock"
  | "archive"
  | "data"
  | "sheet"
  | "font"
  | "docker"
  | "git"
  | "license"
  | "package"
  | "test"
  | "binary"
  | "file"

export type FolderKind = "code" | "test" | "docs" | "config" | "assets" | "deps" | "folder"

/** `primary` and `lane-N` are theme colours; `faint` is the quiet text colour. */
export type Tone = "primary" | "lane-1" | "lane-2" | "lane-3" | "lane-4" | "lane-5" | "lane-6" | "faint"

export interface FileType {
  kind: FileKind
  tone: Tone
  /** One or two characters for the letters theme; empty for a plain file. */
  letters: string
}

const ft = (kind: FileKind, tone: Tone, letters: string): FileType => ({ kind, tone, letters })

const BY_EXT: Record<string, FileType> = {}
const add = (exts: string, type: FileType) => exts.split(" ").forEach((e) => (BY_EXT[e] = type))

add("ts mts cts", ft("code", "primary", "TS"))
add("tsx", ft("react", "primary", "TX"))
add("jsx", ft("react", "lane-2", "JX"))
add("js mjs cjs", ft("code", "lane-2", "JS"))
add("json jsonc json5", ft("json", "lane-2", "{}"))
add("rs", ft("code", "lane-3", "RS"))
add("py pyi pyw", ft("code", "lane-1", "PY"))
add("ipynb", ft("code", "lane-2", "NB"))
add("go", ft("code", "lane-1", "GO"))
add("java", ft("code", "lane-3", "JV"))
add("kt kts", ft("code", "lane-5", "KT"))
add("scala sc", ft("code", "lane-3", "SC"))
add("swift", ft("code", "lane-3", "SW"))
add("c", ft("code", "lane-5", "C"))
add("h", ft("code", "lane-5", "H"))
add("cpp cc cxx hpp hh hxx", ft("code", "lane-5", "C+"))
add("cs", ft("code", "lane-5", "C#"))
add("m mm", ft("code", "lane-5", "OC"))
add("rb erb rake", ft("code", "lane-3", "RB"))
add("php", ft("code", "lane-5", "PH"))
add("lua", ft("code", "primary", "LU"))
add("dart", ft("code", "lane-1", "DA"))
add("ex exs", ft("code", "lane-5", "EX"))
add("zig", ft("code", "lane-2", "ZG"))
add("hs", ft("code", "lane-5", "HS"))
add("r", ft("code", "primary", "R"))
add("diff patch", ft("code", "lane-4", "DF"))
add("sql", ft("data", "lane-5", "SQ"))
add("graphql gql", ft("data", "lane-3", "GQ"))
add("proto", ft("data", "lane-6", "PB"))
add("db sqlite sqlite3", ft("data", "lane-5", "DB"))
add("html htm xhtml xml plist", ft("markup", "lane-3", "<>"))
add("vue", ft("markup", "lane-4", "VU"))
add("svelte", ft("markup", "lane-3", "SV"))
add("astro", ft("markup", "lane-5", "AS"))
add("css", ft("style", "primary", "#"))
add("scss sass", ft("style", "lane-3", "#"))
add("less styl", ft("style", "primary", "#"))
add("md mdx markdown", ft("doc", "lane-1", "MD"))
add("txt rst adoc org log", ft("doc", "faint", "TX"))
add("pdf", ft("doc", "lane-3", "PD"))
add("png jpg jpeg gif webp bmp ico avif heic tif tiff", ft("image", "lane-4", "IM"))
add("svg", ft("image", "lane-2", "SV"))
add("mp4 mov webm mkv avi", ft("video", "lane-5", "VI"))
add("mp3 wav flac ogg m4a aac", ft("audio", "lane-5", "AU"))
add("sh bash zsh fish ps1 bat cmd", ft("shell", "lane-4", "$"))
add("yaml yml", ft("config", "lane-6", "YM"))
add("toml", ft("config", "lane-6", "TM"))
add("ini cfg conf properties editorconfig", ft("config", "lane-6", "CF"))
add("tf hcl", ft("config", "lane-5", "TF"))
add("nix", ft("config", "lane-1", "NX"))
add("env", ft("env", "lane-2", "EN"))
add("pem key crt cer p12", ft("env", "lane-2", "KY"))
add("lock lockb", ft("lock", "lane-6", "LK"))
add("zip tar gz tgz bz2 xz 7z rar jar war dmg", ft("archive", "lane-6", "ZP"))
add("csv tsv xls xlsx numbers", ft("sheet", "lane-4", "CS"))
add("ttf otf woff woff2 eot", ft("font", "lane-6", "FT"))
add("wasm exe dll so dylib bin o a class", ft("binary", "faint", "01"))

const BY_NAME: Record<string, FileType> = {
  "package.json": ft("package", "lane-4", "NP"),
  "cargo.toml": ft("package", "lane-3", "CG"),
  "go.mod": ft("package", "lane-1", "GO"),
  "go.sum": ft("lock", "lane-6", "LK"),
  "pyproject.toml": ft("package", "lane-1", "PY"),
  "gemfile": ft("package", "lane-3", "RB"),
  "package-lock.json": ft("lock", "lane-6", "LK"),
  "pnpm-lock.yaml": ft("lock", "lane-6", "LK"),
  "yarn.lock": ft("lock", "lane-6", "LK"),
  "dockerfile": ft("docker", "lane-1", "DK"),
  "containerfile": ft("docker", "lane-1", "DK"),
  "docker-compose.yml": ft("docker", "lane-1", "DK"),
  "docker-compose.yaml": ft("docker", "lane-1", "DK"),
  "compose.yml": ft("docker", "lane-1", "DK"),
  "compose.yaml": ft("docker", "lane-1", "DK"),
  ".dockerignore": ft("docker", "lane-1", "DK"),
  ".gitignore": ft("git", "lane-3", "GI"),
  ".gitattributes": ft("git", "lane-3", "GI"),
  ".gitmodules": ft("git", "lane-3", "GI"),
  ".gitkeep": ft("git", "lane-3", "GI"),
  "license": ft("license", "lane-2", "LI"),
  "licence": ft("license", "lane-2", "LI"),
  "copying": ft("license", "lane-2", "LI"),
  "makefile": ft("shell", "lane-4", "MK"),
  "justfile": ft("shell", "lane-4", "MK"),
  "cmakelists.txt": ft("config", "lane-5", "CM"),
}

const README = /^readme(\.|$)/
const LICENSE = /^(license|licence|copying)(\.|$)/
const TEST = /(\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|^test_.*\.py$)/
const TOOL_CONFIG = /\.config\.[cm]?[jt]s$|^tsconfig.*\.json$|^\.(prettierrc|eslintrc|babelrc|npmrc|nvmrc)/

export function fileType(path: string): FileType {
  const name = (path.split("/").pop() ?? path).toLowerCase()
  const byName = BY_NAME[name]
  if (byName) return byName
  if (README.test(name)) return ft("readme", "lane-1", "RM")
  if (LICENSE.test(name)) return ft("license", "lane-2", "LI")
  if (name === ".env" || name.startsWith(".env.")) return ft("env", "lane-2", "EN")
  if (TEST.test(name)) return ft("test", "lane-4", "TE")
  if (TOOL_CONFIG.test(name)) return ft("config", "lane-6", "CF")
  if (name.endsWith(".d.ts")) return ft("code", "primary", "DT")
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot + 1) : ""
  return BY_EXT[ext] ?? ft("file", "faint", "")
}

const FOLDERS: Record<string, [FolderKind, Tone]> = {}
const folders = (names: string, kind: FolderKind, tone: Tone) => names.split(" ").forEach((n) => (FOLDERS[n] = [kind, tone]))
folders("src source lib app apps packages crates components pages routes", "code", "primary")
folders("test tests __tests__ spec specs e2e fixtures", "test", "lane-4")
folders("docs doc documentation guides", "docs", "lane-1")
folders(".github .vscode .idea .claude .husky .devcontainer config configs scripts tools", "config", "lane-6")
folders("node_modules vendor target dist build out .next .turbo coverage", "deps", "faint")
folders("assets public static images img icons fonts media styles", "assets", "lane-2")

/** A folder row's name may be a joined chain ("src/lib"): the last part decides. */
export function folderType(name: string): { kind: FolderKind; tone: Tone } {
  const last = (name.split("/").pop() ?? name).toLowerCase()
  const hit = FOLDERS[last]
  return hit ? { kind: hit[0], tone: hit[1] } : { kind: "folder", tone: "faint" }
}
