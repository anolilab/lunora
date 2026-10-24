"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { useQuery as useTanStackQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getSubscriptionRegistry, lunoraQueryKeyFromArgsKey } from "./cache";
import { useLunora } from "./lunora-provider";
import useQuerySubscription from "./query-core";
import { stableWireKey } from "./query-key";
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
 * `["lunora", fn.__lunoraRef, stableWireKey(args), shardKey]` (the args are
 * encoded key-order-independently, so an args object built in a different key
 * order still dedupes, and wire-typed args get distinct entries). The
 * subscription registry shares a single WS subscription across every consumer
 * of the same queryKey; pushes call `queryClient.setQueryData(...)`.
 *
 * Pass `onError` to surface a subscription-scoped error the server pushes (an RLS
 * denial, a query that starts failing server-side). Without it such an error is
 * dropped and the returned value just freezes at its last good result.
 */
const useQuery = <F extends FunctionReference>(function_: F, args: ArgsOf<F> | "skip", options: UseQueryOptions = {}): ReturnOf<F> | undefined => {
    const client = useLunora();
    const queryClient = useQueryClient();
    const { onError, shardKey } = options;

    const skipped = args === "skip";
    const argsRecord = skipped ? {} : (args as Record<string, unknown>);

    // Canonicalise the args once per render: the queryKey, the hydrated-cache
    // peek and the effect dependency below all reuse this string. A skipped hook
    // encodes `{}`, so it keeps sharing the key of `useQuery(fn, {})`.
    const argsKey = stableWireKey(argsRecord);

    // The queryKey is consumed structurally everywhere: TanStack hashes it and
    // the subscription effect keys off `subscriptionKey` (a content hash), so a
    // fresh array reference each render is fine. React Compiler auto-memoizes
    // this derivation; no manual `useMemo` is needed.
    const queryKey = lunoraQueryKeyFromArgsKey(function_.__lunoraRef, argsKey, shardKey);

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
    //
    // Falls back to the value an already-open subscription for the same key
    // holds in memory: the client replays it synchronously on attach, but the
    // attach runs in an effect and TanStack batches that write onto a later
    // tick, so without the seed the first render would read `undefined` where
    // every other adapter reads the held value.
    // `??` is wrong here: a hydrated `null` is a real result, not a missing entry.
    let cachedData: ReturnOf<F> | undefined;

    if (!skipped) {
        const hydratedValue = client.peekHydratedQueryByKey(function_.__lunoraRef, argsKey, shardKey);

        cachedData = (hydratedValue === undefined ? client.peekActiveQuerySnapshot(function_.__lunoraRef, argsRecord, shardKey).value : hydratedValue) as
            ReturnOf<F> | undefined;
    }

    // The client is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache. Swapping the provider's `client` does not remount this subtree; `LunoraProvider` clears the `["lunora", …]` entries on a swap instead.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- neither flagged dependency can be a queryKey member: `client` is the provider-stable, non-serializable client the comment above covers, and `queryKey` IS this key — the queryFn reads the live value under it, which is exactly the key it already belongs to.
    const { data } = useTanStackQuery<ReturnOf<F>>({
        enabled: !skipped && hydrated,
        initialData: cachedData,
        // One execution per mount: the value comes from the subscription the
        // effect below attaches (its first frame is a full snapshot), and the
        // HTTP query runs only when there is no socket to push it.
        queryFn: async ({ signal }) =>
            getSubscriptionRegistry(client).liveValue(queryClient, queryKey, signal, {
                fetch: async () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey }),
            }),
        queryKey,
        // Lunora is push-driven: once the initial fetch resolves, the WS owns
        // freshness, so the value never goes stale on a timer.
        staleTime: Number.POSITIVE_INFINITY,
    });

    useQuerySubscription({ args: argsRecord, argsKey, client, function_, onError, queryClient, queryKey, shardKey, skipped });

    // When skipped, the queryKey collapses to `["lunora", ref, {}, null]` — the
    // same key a real `useQuery(fn, {})` uses — and TanStack still hands back
    // that key's cached `data` for a disabled query. Return `undefined`
    // explicitly so a skipped read never surfaces another consumer's data,
    // matching the documented "no network call, no subscription" contract.
    return skipped ? undefined : data;
};

export default useQuery;
