import React from "react"
import ReactDOM from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { LucideProvider } from "lucide-react"
import "@fontsource-variable/inter"
import "./index.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/toast"
import { queryClient } from "@/lib/query"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LucideProvider strokeWidth={1.75}>
        <TooltipProvider>
          <App />
          <Toaster />
        </TooltipProvider>
      </LucideProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
