import React from "react"
import ReactDOM from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { LucideProvider } from "lucide-react"
import "@fontsource-variable/inter"
import "./index.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/toast"
import { queryClient } from "@/lib/query"
import { api } from "@/lib/api"
import { resolveLang, setLang } from "@/lib/i18n"
import { prefs, useStore } from "@/lib/store"
import App from "./App"

// Language updates reach the backend one after another, so an older one can't land last.
let backendLang: Promise<unknown> = Promise.resolve()

/** Applies the UI language and remounts the app when it changes (strings are read at render). */
function Localized() {
  const pref = useStore(prefs, (s) => s.language)
  const lang = resolveLang(pref)
  setLang(lang)
  React.useEffect(() => {
    // Backend errors follow the UI language.
    backendLang = backendLang.then(() => api.setLanguage(lang)).catch(() => {})
  }, [lang])
  return <App key={lang} />
}

/**
 * Toasts sit below the 38px title bar, clear of its buttons (sonner resets a side missing from
 * `offset` to 24px, so `right` is given too). Re-renders with the language for the kit's
 * screen-reader names (close, notifications); it comes after `Localized`, which applies it first.
 */
function AppToaster() {
  useStore(prefs, (s) => s.language)
  return <Toaster offset={{ top: 46, right: 16 }} />
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LucideProvider strokeWidth={1.75}>
        <TooltipProvider>
          <Localized />
          <AppToaster />
        </TooltipProvider>
      </LucideProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
