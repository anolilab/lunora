import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import type { ComponentType } from "react";
import { useState } from "react";

import "./welcome.css";

// Lunora endpoint. `VITE_LUNORA_URL` (statically replaced by Vite at dev/build)
// wins so you can point at a deployed Worker; otherwise the browser uses the page
// origin and SSR loops back to the local worker.
const resolveLunoraUrl = (): string =>
    (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (typeof window === "undefined" ? "http://localhost:8787" : window.location.origin);

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
