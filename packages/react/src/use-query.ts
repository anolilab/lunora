import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useQuery as useTanStackQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { cirrusQueryKey, getSubscriptionRegistry, serializeQueryKey } from "./cache.js";
import { useCirrus } from "./cirrus-provider.js";
import type { UseQueryOptions } from "./types.js";

/**
 * Subscribe to a server query.
 *
 * Returns `undefined` until the first response lands. Pass `"skip"` for
 * `args` to short-circuit the query (no network call, no subscription).
 *
 * Internally this routes through TanStack Query: the queryKey is
 * `["cirrus", fn.__cirrusRef, args, shardKey]` (TanStack hashes structurally
 * so an args object built in a different key order still dedupes). The
 * subscription registry shares a single WS subscription across every consumer
 * of the same queryKey; pushes call `queryClient.setQueryData(...)`.
 */
export function useQuery<F extends FunctionReference>(fn: F, args: ArgsOf<F> | "skip", options: UseQueryOptions = {}): ReturnOf<F> | undefined {
    const client = useCirrus();
    const queryClient = useQueryClient();
    const { shardKey } = options;

    const skipped = args === "skip";
    const argsRecord = (skipped ? {} : (args as Record<string, unknown>)) ?? {};

    // Memoise the queryKey so the effect dep array tracks structural equality
    // via TanStack's hash, not reference equality of the args object.
    const queryKey = useMemo(() => cirrusQueryKey(fn, argsRecord, shardKey), [fn.__cirrusRef, JSON.stringify(argsRecord), shardKey]);

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- client is provider-stable (it comes from CirrusContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache.
    const { data } = useTanStackQuery<ReturnOf<F>>({
        enabled: !skipped,
        queryFn: () => client.query<F>(fn, argsRecord as ArgsOf<F>, { shardKey }),
        queryKey,
        // Cirrus is push-driven: once the initial fetch resolves, the WS owns
        // freshness. Staleness only matters when the subscription is missing,
        // and the registry handles that with a polling fallback.
        staleTime: Number.POSITIVE_INFINITY,
    });

    useEffect(() => {
        if (skipped) {
            return;
        }

        const registry = getSubscriptionRegistry(client);

        return registry.attach(queryClient, queryKey, fn, argsRecord, shardKey);
    }, [client, queryClient, serializeQueryKey(queryKey), skipped]);

    return data;
}
