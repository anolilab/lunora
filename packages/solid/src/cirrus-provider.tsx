import type { CirrusClient } from "@cirrus/client";
import type { JSX } from "solid-js";

import { CirrusContext } from "./context";

export interface CirrusProviderProps {
    children: JSX.Element;

    /**
     * The framework-neutral transport. Build it once at the app root with
     * `new CirrusClient({ url })` (or `createServerClient` during SSR) and pass
     * it here — the provider does not own its lifecycle, so the same instance
     * survives across route navigations.
     */
    client: CirrusClient;
}

/**
 * Provides a {@link CirrusClient} to the Solid tree via {@link CirrusContext}.
 *
 * Solid's context is reactive-graph scoped rather than render scoped, so unlike
 * the React provider there is no QueryClient to detect or lazily create — the
 * adapter's reactive primitives (`createQuery`, `createMutation`,
 * `hydratePreloaded`) own their own signals and read the client straight from
 * context. Drop one of these at the root of your app:
 *
 * ```tsx
 * const client = new CirrusClient({ url: window.location.origin });
 *
 * render(() => (
 *     &lt;CirrusProvider client={client}>
 *         &lt;App />
 *     &lt;/CirrusProvider>
 * ), root);
 * ```
 */
export const CirrusProvider = (props: CirrusProviderProps): JSX.Element => (
    // `props.client` is read lazily inside the JSX so Solid tracks it: swapping
    // the client prop re-provides the new value to descendants.
    <CirrusContext.Provider value={props.client}>{props.children}</CirrusContext.Provider>
);
