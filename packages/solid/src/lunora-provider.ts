import type { LunoraClient } from "@lunora/client";
import { createComponent, createMemo, untrack } from "solid-js";

import { LunoraClientSwappedContext, LunoraContext } from "./context";
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
 * Swapping the `client` prop for a different instance **remounts the subtree**
 * under the provider. Solid's providers read their value once, so the swap
 * cannot be pushed into primitives that already resolved the client; instead
 * every primitive below is disposed (its subscriptions on the old client torn
 * down) and recreated against the new client, starting from `undefined` — no
 * rows from the old client survive, and `hydratePreloaded` does not seed a value
 * preloaded for the client the provider first rendered with. Local component
 * state under the provider resets with it. Re-reading the same instance is a
 * no-op.
 *
 * Written with `createComponent` rather than JSX on purpose. Solid 1.x and 2.0
 * compile JSX against different runtimes (`solid-js/web` vs `@solidjs/web`), so
 * a JSX source file would force this package to ship two builds; `createComponent`
 * is exported from the `solid-js` root in both majors, and the provider component
 * itself is resolved per-major by {@link providerOf}.
 */
export const LunoraProvider = (props: LunoraProviderProps): SolidElement => {
    const firstClient = untrack(() => props.client);
    const client = createMemo(() => props.client);

    const provide = (current: LunoraClient): unknown =>
        createComponent(providerOf(LunoraContext), {
            get children() {
                return createComponent(providerOf(LunoraClientSwappedContext), {
                    get children() {
                        return props.children;
                    },
                    value: current !== firstClient,
                });
            },
            value: current,
        });

    // Keyed on the client's identity, like `<Show keyed>`: a new client disposes
    // the previous generation's owner (and every subscription under it) and
    // renders the children afresh inside a provider carrying the new value.
    return createMemo<unknown>(() => {
        const current = client();

        return untrack(() => provide(current));
    });
};
