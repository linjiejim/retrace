/** Panes register their keyboard handlers here; App routes keys to the focused area. */
export const keyNav: {
  graph?: (dir: 1 | -1) => void
  changes?: (dir: 1 | -1) => void
  /** → from the graph: open the first file of the selected item. */
  enterChanges?: () => void
  focusSearch?: () => void
} = {}

/**
 * The key belongs to an input method (Enter picks a candidate, Esc drops what is being composed).
 * WebKit ends the composition before that keydown, so `isComposing` is already false then; the
 * key code 229 still says so.
 */
export function isImeKey(e: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return e.isComposing || e.keyCode === 229
}
