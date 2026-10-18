"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { useQueryClient, useSuspenseQuery as useTanStackSuspenseQuery } from "@tanstack/react-query";

import { lunoraQueryKeyFromArgsKey } from "./cache";
import { useLunora } from "./lunora-provider";
import { fetchQuerySnapshot, useQuerySubscription } from "./query-core";
import { stableWireKey } from "./query-key";
import type { UseQueryOptions } from "./types";

/**
 * Subscribe to a server query inside a `<Suspense>` boundary.
 *
 * Unlike `useQuery` the value is never `undefined`: the component suspends
 * until the query's first value lands (the durable read cache when it already
 * holds one, otherwise the server's snapshot) and renders only with data. A
 * failed first fetch throws to the nearest error boundary.
 *
 * It shares `useQuery`'s TanStack cache entry and WebSocket subscription —
 * same query key, same registry — so mixing the two on one query costs one
 * subscription, and pushes keep the value current once it has rendered.
 *
 * There is no `"skip"`: a query that may not run is `useQuery`'s job, since a
 * suspending hook has no value to return for it.
 */
const useSuspenseQuery = <F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: UseQueryOptions = {}): ReturnOf<F> => {
    const client = useLunora();
    const queryClient = useQueryClient();
    const { onError, shardKey } = options;
    const argsRecord = args as Record<string, unknown>;
    const argsKey = stableWireKey(argsRecord);
    const queryKey = lunoraQueryKeyFromArgsKey(function_.__lunoraRef, argsKey, shardKey);
    // `\u0001` marks an absent shardKey so it stays distinct from `""`, as in the queryKey.
    const subscriptionKey = `${function_.__lunoraRef}\u0000${argsKey}\u0000${shardKey ?? "\u0001"}`;

    // The durable read cache loads asynchronously on construction, and a peek before it finishes
    // would miss a value it is about to hold. Until then the snapshot below waits for it instead.
    const cachedData = client.isReady ? (client.peekHydratedQueryByKey(function_.__lunoraRef, argsKey, shardKey) as ReturnOf<F> | undefined) : undefined;

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- `client` is the provider-stable, non-serializable client and is deliberately not a key member (see `useQuery`); `queryKey` IS this key.
    const { data } = useTanStackSuspenseQuery<ReturnOf<F>>({
        initialData: cachedData,
        queryFn: async () => {
            await client.whenReady();

            // `initialData` above could not see the durable cache if it was still loading at first render.
            const hydrated = client.peekHydratedQueryByKey(function_.__lunoraRef, argsKey, shardKey) as ReturnOf<F> | undefined;

            return hydrated ?? fetchQuerySnapshot(client, queryClient, function_, argsRecord, shardKey, queryKey);
        },
        queryKey,
        // Lunora is push-driven: once the first value resolves, the WS owns freshness.
        staleTime: Number.POSITIVE_INFINITY,
    });

    useQuerySubscription({ args: argsRecord, client, function_, onError, queryClient, queryKey, shardKey, skipped: false, subscriptionKey });

    return data;
};

export default useSuspenseQuery;
