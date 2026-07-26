"use client";

import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Client boundary that owns the browser `LunoraClient` and provides it to the
 * tree via `LunoraProvider` (which also installs a TanStack QueryClient tuned
 * for Lunora's push-driven model). Every `useQuery` / `useMutation` /
 * `usePreloadedQuery` call below resolves this instance.
 *
 * The client opens its WebSocket lazily on the first subscription, so creating
 * it here keeps the socket strictly browser-side — exactly what the RSC
 * preload handoff wants: the server fetched over HTTP, the live feed attaches
 * after hydration.
 *
 * Two-worker split: NEXT_PUBLIC_LUNORA_URL points at the standalone Lunora
 * worker (see `wrangler.lunora.jsonc`). It is inlined at build time; the
 * localhost fallback matches `wrangler dev`'s default port during local dev.
 * The fallback is development-only on purpose — in a production build an unset
 * value would otherwise point every visitor's browser at their own machine, so
 * it fails loudly instead.
 */
const lunoraUrl = process.env.NEXT_PUBLIC_LUNORA_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:8787" : undefined);

if (!lunoraUrl) {
    throw new Error("NEXT_PUBLIC_LUNORA_URL must be set — it is inlined into the client bundle at build time.");
}

export function Providers({ children }: { children: ReactNode }) {
    const [client] = useState(() => new LunoraClient({ url: lunoraUrl }));

    return <LunoraProvider client={client}>{children}</LunoraProvider>;
}
