import { cn } from "@/lib/utils"
import logoUrl from "@/assets/logo.svg"

/** The app icon without its shadow: an R drawn as a commit graph. Sits in the window's top-left corner. */
export function Logo({ className }: { className?: string }) {
  return <img src={logoUrl} alt="Retrace" draggable={false} className={cn("pointer-events-none size-4 shrink-0 select-none rounded-[4px]", className)} />
}
