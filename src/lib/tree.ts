import type { FileChange } from "./types"

/** Anything listed by path: a changed file, or a plain file in the files view. */
export interface Pathed {
  path: string
}

export interface FolderNode<T extends Pathed = FileChange> {
  kind: "folder"
  /** Display name; single-child folder chains are joined: "src/features/devices". */
  name: string
  /** Full path, used as the collapse key. */
  path: string
  children: TreeNode<T>[]
}

export interface FileNode<T extends Pathed = FileChange> {
  kind: "file"
  name: string
  file: T
}

export type TreeNode<T extends Pathed = FileChange> = FolderNode<T> | FileNode<T>

interface Draft<T> {
  dirs: Map<string, Draft<T>>
  files: T[]
}

/** Folders first, then files, both by name; chains of lone folders collapse into one row. */
export function buildTree<T extends Pathed>(files: T[]): TreeNode<T>[] {
  const root: Draft<T> = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split("/")
    let node = root
    for (const seg of parts.slice(0, -1)) {
      let next = node.dirs.get(seg)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(seg, next)
      }
      node = next
    }
    node.files.push(f)
  }
  const walk = (node: Draft<T>, prefix: string): TreeNode<T>[] => {
    const folders = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]): FolderNode<T> => {
        let label = name
        let cur = child
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          const [k, v] = [...cur.dirs.entries()][0]
          label += "/" + k
          cur = v
        }
        const path = prefix + label
        return { kind: "folder", name: label, path, children: walk(cur, path + "/") }
      })
    const leaves = [...node.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file): FileNode<T> => ({ kind: "file", name: file.path.split("/").pop() ?? file.path, file }))
    return [...folders, ...leaves]
  }
  return walk(root, "")
}

/** Every folder path in the tree (for expanding everything). */
export function folderPaths<T extends Pathed>(nodes: TreeNode<T>[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "folder") {
      out.push(n.path)
      folderPaths(n.children, out)
    }
  }
  return out
}

export interface VisibleRow<T extends Pathed = FileChange> {
  node: TreeNode<T>
  depth: number
}

/** Rows in screen order, skipping the contents of folders that aren't open. */
export function visibleRows<T extends Pathed>(nodes: TreeNode<T>[], isOpen: (path: string) => boolean, depth = 0, out: VisibleRow<T>[] = []): VisibleRow<T>[] {
  for (const node of nodes) {
    out.push({ node, depth })
    if (node.kind === "folder" && isOpen(node.path)) visibleRows(node.children, isOpen, depth + 1, out)
  }
  return out
}

export const STATUS_LETTER: Record<FileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
}

export const STATUS_LABEL: Record<FileChange["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typechange: "Type changed",
  untracked: "Untracked",
  conflicted: "Conflicted",
}
