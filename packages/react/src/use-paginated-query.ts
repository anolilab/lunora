import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { cirrusQueryKey, getSubscriptionRegistry } from "./cache.js";
import { useCirrus } from "./cirrus-provider.js";
import type { PaginationResult, PaginationStatus, UsePaginatedQueryOptions, UsePaginatedQueryResult } from "./types.js";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
export type PaginatedArgs<F> = Omit<ArgsOf<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
export type PageItemOf<F> = ReturnOf<F> extends { page: Array<infer T> } ? T : unknown;

interface PageRequest {
    cursor: null | string;
    numItems: number;
}

/**
 * Subscribe to a keyset-paginated query and grow the feed page by page.
 *
 * The query function must accept a `paginationOpts: { numItems, cursor }` arg
 * and return a {@link PaginationResult} (the shape `ctx.db.query(...).paginate`
 * yields). Each loaded page is an independent live subscription, so a delta on
 * any page updates in place without dropping the others. `loadMore` appends the
 * next page using the loaded tail's `continueCursor`; it is a no-op unless
 * `status === "CanLoadMore"`.
 *
 * Changing `fn`, the base `args`, or `initialNumItems` resets the feed to its
 * first page.
 *
 * Pages live in TanStack Query's cache under per-page queryKeys; the
 * subscription registry keeps one WS subscription per page open so a delta on
 * any cursor patches the right slice without dropping the rest.
 */
export function usePaginatedQuery<F extends FunctionReference>(
    fn: F,
    args: "skip" | PaginatedArgs<F>,
    options: UsePaginatedQueryOptions,
): UsePaginatedQueryResult<PageItemOf<F>> {
    const client = useCirrus();
    const queryClient = useQueryClient();
    const { initialNumItems, shardKey } = options;

    const skipped = args === "skip";
    const baseArgs = (skipped ? {} : (args as Record<string, unknown>)) ?? {};
    const baseArgsKey = JSON.stringify(baseArgs);

    const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
    const [pages, setPages] = useState<PageRequest[]>(() => [{ cursor: null, numItems: initialNumItems }]);

    // Reset to the first page whenever the query identity, base args, or page
    // size changes. Set-state-during-render (guarded by a ref) is React's
    // sanctioned way to derive state from changing inputs without an extra
    // commit.
    const resetKey = `${fn.__cirrusRef}::${baseArgsKey}::${String(initialNumItems)}::${shardKey ?? ""}`;
    const resetKeyRef = useRef(resetKey);

    if (resetKeyRef.current !== resetKey) {
        resetKeyRef.current = resetKey;
        setPages([{ cursor: null, numItems: initialNumItems }]);
    }

    // Build the (queryKey, args) pair for each loaded page.
    const pageEntries = pages.map((page) => {
        const pageArgs = { ...baseArgs, paginationOpts: { cursor: page.cursor, numItems: page.numItems } };
        const key: QueryKey = cirrusQueryKey(fn, pageArgs, shardKey);

        return { args: pageArgs, key };
    });
    // Stable hash of every loaded page key — used as the effect-dep so we only
    // re-attach when the page set actually changes.
    const pageKeysHash = pageEntries.map(({ key }) => JSON.stringify(key)).join("|");

    // Read latest desired entries from a ref so the effect dep list can stay
    // keyed on `pageKeysHash` alone — args/fn changes already invalidate the hash.
    const desiredRef = useRef<{ entries: typeof pageEntries; fn: F; shardKey: string | undefined }>({ entries: [], fn, shardKey });

    desiredRef.current = { entries: pageEntries, fn, shardKey };

    // Track per-page detach handles so a page falling out of the request set
    // releases its subscription without disturbing the others.
    const detachesRef = useRef(new Map<string, () => void>());

    useEffect(() => {
        const detaches = detachesRef.current;

        if (skipped) {
            for (const detach of detaches.values()) {
                detach();
            }

            detaches.clear();

            return;
        }

        const desired = desiredRef.current;
        const registry = getSubscriptionRegistry(client);
        const wanted = new Set(desired.entries.map(({ key }) => JSON.stringify(key)));

        for (const [hash, detach] of detaches) {
            if (!wanted.has(hash)) {
                detach();
                detaches.delete(hash);
            }
        }

        for (const entry of desired.entries) {
            const hash = JSON.stringify(entry.key);

            if (detaches.has(hash)) {
                continue;
            }

            // Trigger the initial fetch via TanStack so its dedup applies
            // even when two mounts ask for the same page.
            void queryClient.fetchQuery({
                queryFn: () => client.query(desired.fn, entry.args as ArgsOf<F>, { shardKey: desired.shardKey }),
                queryKey: entry.key,
                staleTime: Number.POSITIVE_INFINITY,
            });

            detaches.set(hash, registry.attach(queryClient, entry.key, desired.fn, entry.args, desired.shardKey));
        }
    }, [client, queryClient, pageKeysHash, skipped]);

    // Release every page on unmount.
    useEffect(
        () => () => {
            for (const detach of detachesRef.current.values()) {
                detach();
            }

            detachesRef.current.clear();
        },
        [],
    );

    // Subscribe to TanStack cache events so a setQueryData from the registry
    // triggers a re-render here.
    useEffect(() => {
        const cache = queryClient.getQueryCache();
        const unsubscribe = cache.subscribe((event) => {
            const hash = JSON.stringify(event.query.queryKey);

            if (pageEntries.some(({ key }) => JSON.stringify(key) === hash)) {
                forceRender();
            }
        });

        return unsubscribe;
    }, [queryClient, pageKeysHash]);

    const pageResults: Array<PaginationResult<PageItemOf<F>> | undefined> = skipped
        ? []
        : pageEntries.map(({ key }) => queryClient.getQueryData<PaginationResult<PageItemOf<F>>>(key));

    const results: PageItemOf<F>[] = [];

    for (const result of pageResults) {
        if (result) {
            results.push(...result.page);
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

    const nextCursorRef = useRef<null | string | undefined>(undefined);

    nextCursorRef.current = status === "CanLoadMore" ? nextCursor : undefined;

    const loadMore = useCallback((numItems: number) => {
        const cursor = nextCursorRef.current;

        if (cursor === undefined) {
            return;
        }

        setPages((current) => [...current, { cursor, numItems }]);
    }, []);

    return {
        isLoading: !skipped && (status === "LoadingFirstPage" || status === "LoadingMore"),
        loadMore,
        results,
        status,
    };
}
