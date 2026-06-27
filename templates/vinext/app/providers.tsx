"use client";

import { LunoraProvider } from "@lunora/react";

// Lunora endpoint. `VITE_LUNORA_URL` (statically replaced by Vite at dev/build)
// wins so you can point at a deployed Worker; otherwise the browser uses the page
// origin and SSR loops back to the local worker (same worker, via the composed
// `virtual:lunora/worker` entry).
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (typeof window === "undefined" ? "http://localhost:8787" : window.location.origin);

/**
 * Client boundary that mounts the LunoraProvider so every child component can
 * call `useQuery` / `useMutation` / `useSubscription`. App-Router providers must
 * be client components (they hold React context), hence the `"use client"`.
 */
export function Providers({ children }: { children: React.ReactNode }) {
    return <LunoraProvider url={lunoraUrl}>{children}</LunoraProvider>;
}
