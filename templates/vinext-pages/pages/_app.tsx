import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import type { ComponentType } from "react";
import { useState } from "react";

import "./welcome.css";

// Lunora endpoint. `VITE_LUNORA_URL` wins so you can point at a deployed Worker;
// `vite.config.ts` otherwise defines it as the dev server's resolved origin,
// because `virtual:lunora/worker` serves Lunora from this same worker. In a
// build with neither set, the browser uses its own page origin — also this
// worker.
const isServer = typeof globalThis.window === "undefined";
const resolveLunoraUrl = (): string =>
    (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (isServer ? "http://localhost:3000" : globalThis.location.origin);

/**
 * Custom App (Pages Router). Wraps every page in the LunoraProvider so any
 * component can call `useQuery` / `useMutation` / `useSubscription`. Props are
 * typed inline so the template doesn't depend on `next/app` types (vinext
 * provides the `next/*` shims, but this keeps the starter self-contained).
 */
export default function App({ Component, pageProps }: { Component: ComponentType<Record<string, unknown>>; pageProps: Record<string, unknown> }) {
    const [client] = useState(() => new LunoraClient({ url: resolveLunoraUrl() }));

    return (
        <LunoraProvider client={client}>
            <Component {...pageProps} />
        </LunoraProvider>
    );
}
