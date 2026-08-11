"use client";

import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import type { ReactNode } from "react";
import { useState } from "react";

// Lunora endpoint. `VITE_LUNORA_URL` wins so you can point at a deployed Worker;
// `vite.config.ts` otherwise defines it as the dev server's resolved origin,
// because `virtual:lunora/worker` serves Lunora from this same worker. In a
// build with neither set, the browser uses its own page origin — also this
// worker.
const isServer = typeof globalThis.window === "undefined";
const resolveLunoraUrl = (): string =>
    (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (isServer ? "http://localhost:3000" : globalThis.location.origin);

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
