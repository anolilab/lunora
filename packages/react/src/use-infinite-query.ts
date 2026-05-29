import type { FunctionReference } from "@cirrus/client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { getCache } from "./cache.js";
import { useCirrus } from "./cirrus-provider.js";
import type { PaginationResult, PaginationStatus, UseInfiniteQueryOptions, UseInfiniteQueryResult } from "./types.js";
import type { PageItemOf, PaginatedArgs } from "./use-paginated-query.js";

interface PageRequest {
    cursor: null | string;
    numItems: number;
}

/**
 * Subscribe to a keyset-paginated query and expose its pages discretely.
 *
 * Mirrors {@link usePaginatedQuery}'s per-page live-subscription plumbing but
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
export function useInfiniteQuery<F extends FunctionReference>(
    fn: F,
    args: "skip" | PaginatedArgs<F>,
    options: UseInfiniteQueryOptions,
): UseInfiniteQueryResult<PageItemOf<F>> {
    const client = useCirrus();
    const cache = getCache(client);
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

    const pageEntries: Array<[string, Record<string, unknown>]> = pages.map((page) => {
        const pageArgs = { ...baseArgs, paginationOpts: { cursor: page.cursor, numItems: page.numItems } };

        return [cache.keyOf(fn, pageArgs, shardKey), pageArgs];
    });
    const pageKeys = pageEntries.map(([key]) => key);
    const pageKeysKey = pageKeys.join("|");

    // The effect reads the latest desired (key → args) mapping from a ref so the
    // dependency array can stay keyed on `pageKeysKey` alone, matching useQuery.
    const desiredRef = useRef<{ entries: Array<[string, Record<string, unknown>]>; fn: F; shardKey: string | undefined }>({
        entries: [],
        fn,
        shardKey,
    });

    desiredRef.current = { entries: pageEntries, fn, shardKey };

    const handlesRef = useRef(new Map<string, () => void>());

    useEffect(() => {
        const handles = handlesRef.current;
        const notify = (): void => {
            forceRender();
        };

        if (skipped) {
            for (const release of handles.values()) {
                release();
            }

            handles.clear();

            return;
        }

        const desired = desiredRef.current;
        const wanted = new Set(desired.entries.map(([key]) => key));

        // Release pages that fell out of the request set, keeping survivors live
        // so a `fetchNextPage` never flickers earlier pages back to a loading
        // state.
        for (const [key, release] of handles) {
            if (!wanted.has(key)) {
                release();
                handles.delete(key);
            }
        }

        for (const [key, pageArgs] of desired.entries) {
            if (!handles.has(key)) {
                handles.set(key, cache.acquire(desired.fn, pageArgs, desired.shardKey, notify).release);
            }
        }

        notify();
    }, [cache, pageKeysKey, skipped]);

    // Release every page on unmount.
    useEffect(
        () => () => {
            for (const release of handlesRef.current.values()) {
                release();
            }

            handlesRef.current.clear();
        },
        [],
    );

    const pageResults: Array<PaginationResult<PageItemOf<F>> | undefined> = skipped
        ? []
        : pageKeys.map((key) => cache.peek(key)?.data as PaginationResult<PageItemOf<F>> | undefined);

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

    // Stash the cursor `fetchNextPage` should append (and the default page size)
    // so the callback identity stays stable while still reading the freshest
    // tail cursor.
    const nextRef = useRef<{ cursor: null | string | undefined; defaultNumItems: number }>({ cursor: undefined, defaultNumItems: initialNumItems });

    nextRef.current = { cursor: status === "CanLoadMore" ? nextCursor : undefined, defaultNumItems: initialNumItems };

    const fetchNextPage = useCallback((numItems?: number) => {
        const { cursor, defaultNumItems } = nextRef.current;

        if (cursor === undefined) {
            return;
        }

        setPages((current) => [...current, { cursor, numItems: numItems ?? defaultNumItems }]);
    }, []);

    return {
        fetchNextPage,
        hasNextPage: status === "CanLoadMore",
        // A pending page beyond the first is a `fetchNextPage` in flight, distinct from the first-page load.
        isFetchingNextPage: !skipped && status === "LoadingMore",
        // `skip` is an intentional pause, not a pending fetch, so it never counts as loading.
        isLoading: !skipped && status === "LoadingFirstPage",
        pages: resolvedPages,
        status,
    };
}
