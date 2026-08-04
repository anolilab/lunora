import type { LunoraClient } from "@lunora/client";
import type { JSX } from "solid-js";

import { LunoraContext } from "./context";

export interface LunoraProviderProps {
    children: JSX.Element;

    /**
     * The framework-neutral transport. Build it once at the app root with
     * `new LunoraClient({ url })` (or `createServerClient` during SSR) and pass
     * it here — the provider does not own its lifecycle, so the same instance
     * survives across route navigations.
     */
    client: LunoraClient;
}

/**
 * Provides a {@link LunoraClient} to the Solid tree via {@link LunoraContext}.
 *
 * Solid's context is reactive-graph scoped rather than render scoped, so unlike
 * the React provider there is no QueryClient to detect or lazily create — the
 * adapter's reactive primitives (`createQuery`, `createMutation`,
 * `hydratePreloaded`) own their own signals and read the client straight from
 * context. Drop one of these at the root of your app:
 *
 * ```tsx
 * const client = new LunoraClient({ url: window.location.origin });
 *
 * render(() => (
 *     <LunoraProvider client={client}>
 *         <App />
 *     </LunoraProvider>
 * ), root);
 * ```
 */
export const LunoraProvider = (props: LunoraProviderProps): JSX.Element => (
    // `props.client` is read lazily inside the JSX so Solid tracks it: swapping
    // the client prop re-provides the new value to descendants.
    <LunoraContext.Provider value={props.client}>{props.children}</LunoraContext.Provider>
);
