import { LoaderCircle } from "lucide-react"
import { cn } from "@/lib/utils"

/** Short waits only (a button, a field). Content loading uses Skeleton. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <LoaderCircle
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("size-4 animate-spin", className)}
    />
  )
}
