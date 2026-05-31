import type { FunctionReference, Preloaded } from "@cirrus/client";
import { useQuery as useTanStackQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { cirrusQueryKey, getSubscriptionRegistry } from "./cache.js";
import { useCirrus } from "./cirrus-provider.js";

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live.
 *
 * The first render returns the preloaded value (TanStack's `initialData`),
 * so the server markup and the initial client markup match — no hydration
 * mismatch, no loading flash. After mount, a WS subscription attaches so
 * later server pushes update the value just like {@link useQuery}.
 *
 * The {@link Preloaded} token's `value` seeds `initialData`; we don't need a
 * full dehydrate/hydrate dance because the consumer hands us the resolved
 * value directly. Apps that want to share a pre-populated QueryClient across
 * many preloaded queries can pass their own `queryClient` to `CirrusProvider`
 * and hydrate it themselves via TanStack's `hydrate(qc, dehydratedState)`.
 */
export function usePreloadedQuery<T>(preloaded: Preloaded<T>): T {
    const client = useCirrus();
    const queryClient = useQueryClient();

    const { args, functionPath, shardKey, value } = preloaded;
    const fn = useMemo<FunctionReference>(() => ({ __cirrusRef: functionPath }), [functionPath]);
    const queryKey = useMemo(() => cirrusQueryKey(fn, args, shardKey), [fn.__cirrusRef, JSON.stringify(args), shardKey]);

    const { data } = useTanStackQuery<T>({
        // Seed the cache with the server value so the first paint doesn't
        // re-fetch. TanStack treats `initialData` as fresh — the WS push from
        // the registry is what supplies subsequent updates.
        initialData: value,
        queryFn: () => client.query(fn, args as Record<string, never>, { shardKey }) as Promise<T>,
        queryKey,
        staleTime: Number.POSITIVE_INFINITY,
    });

    useEffect(() => {
        const registry = getSubscriptionRegistry(client);

        return registry.attach(queryClient, queryKey, fn, args, shardKey);
    }, [client, queryClient, JSON.stringify(queryKey)]);

    // `data` is typed as `T | undefined` because TanStack hedges its type
    // against an empty initialData, but our `initialData: value` is always
    // present so the cast is safe.
    return data as T;
}
