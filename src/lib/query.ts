import { QueryClient } from "@tanstack/react-query"

/** One client for the app, also used outside React (menu commands). */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})
