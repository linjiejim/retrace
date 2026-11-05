import { cn } from "@/lib/utils"

/**
 * Static placeholder shaped like the content that is coming.
 * No shimmer, no pulse. Show it only after 300ms (useDelayedFlag).
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("rounded-sm bg-muted", className)} />
}
