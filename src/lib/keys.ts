/** Panes register their keyboard handlers here; App routes keys to the focused area. */
export const keyNav: {
  graph?: (dir: 1 | -1) => void
  changes?: (dir: 1 | -1) => void
  /** → from the graph: open the first file of the selected item. */
  enterChanges?: () => void
  focusSearch?: () => void
} = {}
