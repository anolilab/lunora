import type { CirrusClient, FunctionReference, Preloaded } from "@cirrus/client";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { getCirrusClient } from "./context";

/**
 * Hydrate a query store from a {@link Preloaded} token produced by
 * `preloadQuery` during SSR, then keep it live — the reactive-loader handoff.
 *
 * The store is seeded **synchronously** with `preloaded.value`, so the very
 * first read (`$store` during hydration) returns the server value with no
 * loading flash and no hydration mismatch — there is no `undefined` window and
 * no refetch. When the store gains its first subscriber on the client, a live
 * WS subscription attaches and every subsequent delta re-emits, exactly like a
 * plain `query` store. This is the Svelte equivalent of React's
 * `usePreloadedQuery`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setCirrusClient`.
 *
 * Note on SSR: `readable`'s start callback only runs when the store is actually
 * subscribed (the browser), so on the server the store simply holds the seeded
 * value and opens no socket. The token's `value` is the single source of truth
 * for the first paint either way.
 */
const hydratePreloaded = <T>(preloaded: Preloaded<T>, client?: CirrusClient): Readable<T> => {
    const resolvedClient = client ?? getCirrusClient();
    const { args, functionPath, shardKey, value } = preloaded;
    const functionRef: FunctionReference = { __cirrusRef: functionPath };

    // Seed `readable` with the preloaded value so the synchronous first read
    // already has data — the start callback (which opens the WS) runs only once
    // a subscriber attaches, i.e. client-side after hydration.
    return readable<T>(value, (set) =>
        resolvedClient.subscribe(
            functionRef,
            args,
            (next: unknown) => {
                set(next as T);
            },
            { shardKey },
        ),
    );
};

export default hydratePreloaded;
