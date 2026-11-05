import { useCallback, useState } from "react"

/**
 * Open state for overlays that may hold unsaved input.
 * When `dirty` and the user tries to close (Esc, scrim, ✕, Cancel), ask
 * first instead of closing. Closing from code (after a save) is direct.
 */
export function useGuardedOpen({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  dirty = false,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  dirty?: boolean
}) {
  const [inner, setInner] = useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : inner
  const [asking, setAsking] = useState(false)

  const commit = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )

  const request = useCallback(
    (next: boolean) => {
      if (!next && dirty) {
        setAsking(true)
        return
      }
      commit(next)
    },
    [commit, dirty],
  )

  return {
    open,
    onOpenChange: request,
    discard: {
      open: asking,
      keep: () => setAsking(false),
      discard: () => {
        setAsking(false)
        commit(false)
      },
    },
  }
}
