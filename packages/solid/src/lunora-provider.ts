import type { LunoraClient } from "@lunora/client";
import { createComponent } from "solid-js";

import { LunoraContext } from "./context";
import type { SolidChildren, SolidElement } from "./solid-compat";
import { providerOf } from "./solid-compat";

export interface LunoraProviderProps {
    children: SolidChildren;

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
 *
 * Written with `createComponent` rather than JSX on purpose. Solid 1.x and 2.0
 * compile JSX against different runtimes (`solid-js/web` vs `@solidjs/web`), so
 * a JSX source file would force this package to ship two builds; `createComponent`
 * is exported from the `solid-js` root in both majors, and the provider component
 * itself is resolved per-major by {@link providerOf}. The `get` accessors keep
 * both props lazy, so swapping the `client` prop re-provides the new value to
 * descendants exactly as the JSX form did.
 */
export const LunoraProvider = (props: LunoraProviderProps): SolidElement =>
    createComponent(providerOf(LunoraContext), {
        get children() {
            return props.children;
        },
        get value() {
            return props.client;
        },
    });
