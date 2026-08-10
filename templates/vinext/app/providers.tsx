"use client";

import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import type { ReactNode } from "react";
import { useState } from "react";

// Lunora endpoint. `VITE_LUNORA_URL` (statically replaced by Vite at dev/build)
// wins so you can point at a deployed Worker; otherwise the browser uses the page
// origin and SSR loops back to the local worker (same worker, via the composed
// `virtual:lunora/worker` entry).
const resolveLunoraUrl = (): string =>
    (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (typeof window === "undefined" ? "http://localhost:8787" : window.location.origin);

/**
 * Client boundary that owns the browser `LunoraClient` and provides it to the
 * tree, so every child component can call `useQuery` / `useMutation` /
 * `useSubscription`. App-Router providers must be client components (they hold
 * React context), hence the `"use client"`.
 *
 * The client opens its WebSocket lazily on the first subscription, so creating
 * it in a `useState` initializer keeps the socket strictly browser-side.
 */
export function Providers({ children }: { children: ReactNode }) {
    const [client] = useState(() => new LunoraClient({ url: resolveLunoraUrl() }));

    return <LunoraProvider client={client}>{children}</LunoraProvider>;
}
