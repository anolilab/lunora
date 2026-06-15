"use client";

import type { FunctionReference, Preloaded } from "@lunora/client";
import { useQuery as useTanStackQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { lunoraQueryKey, getSubscriptionRegistry, serializeQueryKey } from "./cache";
import { useLunora } from "./lunora-provider";

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live.
 *
 * The first render returns the preloaded value (TanStack's `initialData`),
 * so the server markup and the initial client markup match — no hydration
 * mismatch, no loading flash. After mount, a WS subscription attaches so
 * later server pushes update the value just like `useQuery`.
 *
 * The {@link Preloaded} token's `value` seeds `initialData`; we don't need a
 * full dehydrate/hydrate dance because the consumer hands us the resolved
 * value directly. Apps that want to share a pre-populated QueryClient across
 * many preloaded queries can pass their own `queryClient` to `LunoraProvider`
 * and hydrate it themselves via TanStack's `hydrate(qc, dehydratedState)`.
 */
const usePreloadedQuery = <T>(preloaded: Preloaded<T>): T => {
    const client = useLunora();
    const queryClient = useQueryClient();

    const { args, functionPath, shardKey, value } = preloaded;
    const functionRef = useMemo<FunctionReference>(() => {
        return { __lunoraRef: functionPath };
    }, [functionPath]);
    const queryKey = useMemo(() => lunoraQueryKey(functionRef, args, shardKey), [functionRef.__lunoraRef, JSON.stringify(args), shardKey]);

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- client is provider-stable (it comes from LunoraContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache.
    const { data } = useTanStackQuery<T>({
        // Seed the cache with the server value so the first paint doesn't
        // re-fetch. TanStack treats `initialData` as fresh — the WS push from
        // the registry is what supplies subsequent updates.
        initialData: value,
        queryFn: () => client.query(functionRef, args, { shardKey }) as Promise<T>,
        queryKey,
        staleTime: Number.POSITIVE_INFINITY,
    });

    useEffect(() => {
        const registry = getSubscriptionRegistry(client);

        return registry.attach(queryClient, queryKey, functionRef, args, shardKey);
    }, [client, queryClient, serializeQueryKey(queryKey)]);

    // TanStack types `data` as `T | undefined` even with `initialData` because
    // the option could be a falsy value. We always pass the preloaded `value`
    // so the only way to land here with `undefined` is the consumer preloading
    // an explicit `undefined` — preserve that semantic via `??` instead of
    // forcing a cast that lies about possible runtime states.
    return data ?? value;
};

/**
 * The PLAN4 §1 framework-neutral name for the preloaded-hydration handoff:
 * `hydratePreloaded(preloaded)` seeds the SSR value on the first paint, then
 * attaches a live WS subscription on mount. It is a thin alias of
 * {@link usePreloadedQuery} so the React adapter exposes the same
 * `hydratePreloaded` primitive every other adapter (Solid, Svelte, Vue) will,
 * while existing callers of `usePreloadedQuery` keep working unchanged.
 *
 * It carries React's Rules-of-Hooks contract (it calls hooks internally), so
 * call it like a hook — at the top level of a component, unconditionally.
 */
const hydratePreloaded = <T>(preloaded: Preloaded<T>): T => usePreloadedQuery(preloaded);

export { hydratePreloaded };
export default usePreloadedQuery;
