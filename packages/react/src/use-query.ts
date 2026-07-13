"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { useQuery as useTanStackQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getSubscriptionRegistry, lunoraQueryKey, serializeQueryKey } from "./cache";
import { useLunora } from "./lunora-provider";
import type { UseQueryOptions } from "./types";

/**
 * Subscribe to a server query.
 *
 * Returns `undefined` until the first response lands. Pass `"skip"` for
 * `args` to short-circuit the query (no network call, no subscription).
 *
 * When the `LunoraClient` was created with `hydrateOnStart: true` and a
 * `queryCache` adapter, the first **enabled** render waits for the durable
 * read cache to finish loading. If a cached value exists for this query it
 * is fed as `initialData` so the user sees it immediately — no undefined
 * flash before the socket round-trip.
 *
 * Internally this routes through TanStack Query: the queryKey is
 * `["lunora", fn.__lunoraRef, args, shardKey]` (TanStack hashes structurally
 * so an args object built in a different key order still dedupes). The
 * subscription registry shares a single WS subscription across every consumer
 * of the same queryKey; pushes call `queryClient.setQueryData(...)`.
 */
const useQuery = <F extends FunctionReference>(function_: F, args: ArgsOf<F> | "skip", options: UseQueryOptions = {}): ReturnOf<F> | undefined => {
    const client = useLunora();
    const queryClient = useQueryClient();
    const { shardKey } = options;

    const skipped = args === "skip";
    const argsRecord = skipped ? {} : (args as Record<string, unknown>);

    // The queryKey is consumed structurally everywhere: TanStack hashes it and
    // the subscription effect keys off `serializeQueryKey(queryKey)` (a content
    // hash), so a fresh array reference each render is fine. React Compiler
    // auto-memoizes this derivation; no manual `useMemo` is needed.
    const queryKey = lunoraQueryKey(function_, argsRecord, shardKey);

    // Hydration gate — when `hydrateOnStart` is active the durable read cache
    // loads asynchronously on construction. Block the live query until it
    // finishes so the first enabled render can seed cached data instead of
    // showing an undefined flash before the socket round-trip.
    const [hydrated, setHydrated] = useState<boolean>(client.isReady);

    useEffect(() => {
        if (!hydrated) {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises, promise/catch-or-return, promise/always-return -- fire-and-forget: whenReady() never rejects (its promise is resolve-only) and completion is tracked via the state update
            client.whenReady().then(() => {
                setHydrated(true);
            });
        }
    }, [client, hydrated]);

    // Peek at cached data every render (not only while hydration is pending).
    // This ensures `initialData` keeps the cached value even after hydration
    // completes and the query transitions from disabled→enabled, preventing an
    // undefined flash between the cached-first-render and the server response.
    const cachedData: ReturnOf<F> | undefined = skipped
        ? undefined
        : (client.peekHydratedQuery(function_.__lunoraRef, argsRecord, shardKey) as ReturnOf<F> | undefined);

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- client is provider-stable (it comes from LunoraContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache.
    const { data } = useTanStackQuery<ReturnOf<F>>({
        enabled: !skipped && hydrated,
        initialData: cachedData,
        queryFn: () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey }),
        queryKey,
        // Lunora is push-driven: once the initial fetch resolves, the WS owns
        // freshness. Staleness only matters when the subscription is missing,
        // and the registry handles that with a polling fallback.
        staleTime: Number.POSITIVE_INFINITY,
    });

    useEffect(() => {
        if (skipped) {
            return () => {};
        }

        const registry = getSubscriptionRegistry(client);

        return registry.attach(queryClient, queryKey, function_, argsRecord, shardKey);
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the WS subscription re-attaches only when the serialized query key (a stable content hash), the client, or the skip flag changes — not on every fresh `function_`/`argsRecord`/`shardKey` object identity. `client` is provider-stable (swapping it remounts the provider subtree).
    }, [client, queryClient, serializeQueryKey(queryKey), skipped]);

    // When skipped, the queryKey collapses to `["lunora", ref, {}, null]` — the
    // same key a real `useQuery(fn, {})` uses — and TanStack still hands back
    // that key's cached `data` for a disabled query. Return `undefined`
    // explicitly so a skipped read never surfaces another consumer's data,
    // matching the documented "no network call, no subscription" contract.
    return skipped ? undefined : data;
};

export default useQuery;
