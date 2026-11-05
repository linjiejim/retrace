"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Loading indicators that don't flicker: show only if `on` lasts longer than
 * `delay`, and once shown keep them for at least `minDuration`.
 */
export function useDelayedFlag(on: boolean, { delay = 300, minDuration = 600 } = {}) {
  const [shown, setShown] = useState(false)
  const shownAt = useRef(0)

  useEffect(() => {
    if (on && !shown) {
      const t = setTimeout(() => {
        shownAt.current = Date.now()
        setShown(true)
      }, delay)
      return () => clearTimeout(t)
    }
    if (!on && shown) {
      const left = Math.max(0, minDuration - (Date.now() - shownAt.current))
      const t = setTimeout(() => setShown(false), left)
      return () => clearTimeout(t)
    }
  }, [on, shown, delay, minDuration])

  return shown
}
