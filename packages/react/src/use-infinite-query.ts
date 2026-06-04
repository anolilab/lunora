"use client";

import type { FunctionReference } from "@cirrus/client";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { cirrusQueryKey, getSubscriptionRegistry, serializeQueryKey } from "./cache.js";
import { useCirrus } from "./cirrus-provider.js";
import type { PaginationResult, PaginationStatus, UseInfiniteQueryOptions, UseInfiniteQueryResult } from "./types.js";
import useLazyRef from "./use-lazy-ref.js";
import type { PageItemOf, PaginatedArgs } from "./use-paginated-query.js";

interface PageRequest {
    // `null | string` mirrors the server's `continueCursor` wire shape: `null`
    // is the explicit "first page / no cursor" marker sent in `paginationOpts`.
    cursor: null | string;
    numItems: number;
}

/**
 * Subscribe to a keyset-paginated query and expose its pages discretely.
 *
 * Mirrors `usePaginatedQuery`'s per-page live-subscription plumbing but
 * keeps each page as its own inner array rather than flattening them, and adds
 * the TanStack-Query-style `fetchNextPage` / `hasNextPage` /
 * `isFetchingNextPage` shape. Each loaded page is an independent live
 * subscription, so a delta on any page updates in place without dropping the
 * others. `fetchNextPage` appends the next page using the loaded tail's
 * `continueCursor`; it is a no-op unless `status === "CanLoadMore"`.
 *
 * Changing `fn`, the base `args`, `initialNumItems`, or `shardKey` resets the
 * feed to its first page.
 */
const useInfiniteQuery = <F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: UseInfiniteQueryOptions,
): UseInfiniteQueryResult<PageItemOf<F>> => {
    const client = useCirrus();
    const queryClient = useQueryClient();
    const { initialNumItems, shardKey } = options;

    const skipped = args === "skip";
    const baseArgs = skipped ? {} : (args as Record<string, unknown>);
    const baseArgsKey = JSON.stringify(baseArgs);

    const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
    // eslint-disable-next-line unicorn/no-null -- `cursor: null` is the wire-shape first-page marker sent to the server in `paginationOpts`.
    const [pages, setPages] = useState<PageRequest[]>(() => [{ cursor: null, numItems: initialNumItems }]);

    const resetKey = `${function_.__cirrusRef}::${baseArgsKey}::${String(initialNumItems)}::${shardKey ?? ""}`;
    const resetKeyRef = useRef(resetKey);

    if (resetKeyRef.current !== resetKey) {
        resetKeyRef.current = resetKey;
        // eslint-disable-next-line unicorn/no-null -- `cursor: null` is the wire-shape first-page marker sent to the server in `paginationOpts`.
        setPages([{ cursor: null, numItems: initialNumItems }]);
    }

    const pageEntries = pages.map((page) => {
        const pageArgs = { ...baseArgs, paginationOpts: { cursor: page.cursor, numItems: page.numItems } };
        const key: QueryKey = cirrusQueryKey(function_, pageArgs, shardKey);

        return { args: pageArgs, key };
    });
    const pageKeysHash = pageEntries.map(({ key }) => serializeQueryKey(key)).join("|");

    const desiredRef = useRef<{ entries: typeof pageEntries; fn: F; shardKey: string | undefined }>({ entries: [], fn: function_, shardKey });

    useEffect(() => {
        desiredRef.current = { entries: pageEntries, fn: function_, shardKey };
    });

    const detachesRef = useLazyRef((): Map<string, () => void> => new Map());

    // The CirrusClient the current detach handles are bound to. Page-key hashes
    // don't encode client identity, so a client swap (same page keys) would
    // otherwise leave every subscription attached to the old client — detach
    // and rebuild against the new one when this changes.
    const detachClientRef = useRef(client);

    useEffect(() => {
        const detaches = detachesRef.current;

        // Client changed while page keys stayed the same: tear every page's
        // subscription off the old client so the loop below re-attaches them to
        // the new one.
        if (detachClientRef.current !== client) {
            for (const detach of detaches.values()) {
                detach();
            }

            detaches.clear();
            detachClientRef.current = client;
        }

        if (skipped) {
            for (const detach of detaches.values()) {
                detach();
            }

            detaches.clear();

            return;
        }

        const desired = desiredRef.current;
        const registry = getSubscriptionRegistry(client);
        const wanted = new Set(desired.entries.map(({ key }) => serializeQueryKey(key)));

        for (const [hash, detach] of detaches) {
            if (!wanted.has(hash)) {
                detach();
                detaches.delete(hash);
            }
        }

        for (const entry of desired.entries) {
            const hash = serializeQueryKey(entry.key);

            if (detaches.has(hash)) {
                continue;
            }

            // eslint-disable-next-line @tanstack/query/exhaustive-deps -- client is provider-stable (it comes from CirrusContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache. Client swaps are handled explicitly via detachClientRef above.
            const initialFetch = queryClient.fetchQuery({
                queryFn: () =>
                    (client.query as (function_: F, args: unknown, options: { shardKey?: string }) => Promise<unknown>)(desired.fn, entry.args, {
                        shardKey: desired.shardKey,
                    }),
                queryKey: entry.key,
                staleTime: Number.POSITIVE_INFINITY,
            });

            // Initial fetch failures surface through the live subscription /
            // polling fallback; swallow here so the promise doesn't float.
            initialFetch.catch(() => {});

            detaches.set(hash, registry.attach(queryClient, entry.key, desired.fn, entry.args, desired.shardKey));
        }
    }, [client, queryClient, pageKeysHash, skipped]);

    useEffect(
        () => () => {
            for (const detach of detachesRef.current.values()) {
                detach();
            }

            detachesRef.current.clear();
        },
        [],
    );

    useEffect(() => {
        const cache = queryClient.getQueryCache();
        const unsubscribe = cache.subscribe((event) => {
            // The registry pushes page data via `setQueryData`, which emits an
            // `"updated"` event. Every other event type (observer lifecycle,
            // add/remove, etc.) fires on unrelated sibling churn and would only
            // drive a redundant re-render — skip it before any serialization so
            // the per-event JSON.stringify + page scan never runs on them.
            if (event.type !== "updated") {
                return;
            }

            const hash = serializeQueryKey(event.query.queryKey as QueryKey);

            if (pageEntries.some(({ key }) => serializeQueryKey(key) === hash)) {
                forceRender();
            }
        });

        return unsubscribe;
    }, [queryClient, pageKeysHash]);

    const pageResults: (PaginationResult<PageItemOf<F>> | undefined)[] = skipped
        ? []
        : pageEntries.map(({ key }) => queryClient.getQueryData<PaginationResult<PageItemOf<F>>>(key));

    const resolvedPages: PageItemOf<F>[][] = [];

    for (const result of pageResults) {
        if (result) {
            resolvedPages.push(result.page);
        }
    }

    let status: PaginationStatus;
    let nextCursor: null | string | undefined;

    if (skipped || !pageResults[0]) {
        status = "LoadingFirstPage";
    } else {
        const tail = pageResults.at(-1);

        if (!tail) {
            status = "LoadingMore";
        } else if (tail.isDone || tail.continueCursor === null) {
            status = "Exhausted";
        } else {
            status = "CanLoadMore";
            nextCursor = tail.continueCursor;
        }
    }

    const nextRef = useRef<{ cursor: null | string | undefined; defaultNumItems: number }>({ cursor: undefined, defaultNumItems: initialNumItems });

    nextRef.current = { cursor: status === "CanLoadMore" ? nextCursor : undefined, defaultNumItems: initialNumItems };

    const fetchNextPage = useCallback((numberItems?: number) => {
        const { cursor, defaultNumItems } = nextRef.current;

        if (cursor === undefined) {
            return;
        }

        setPages((current) => [...current, { cursor, numItems: numberItems ?? defaultNumItems }]);
    }, []);

    return {
        fetchNextPage,
        hasNextPage: status === "CanLoadMore",
        isFetchingNextPage: !skipped && status === "LoadingMore",
        isLoading: !skipped && status === "LoadingFirstPage",
        pages: resolvedPages,
        status,
    };
};

export default useInfiniteQuery;
