"use client";

import type { FunctionReference } from "@lunora/client";
import { useEffect, useRef } from "react";

import type { UseInfiniteQueryOptions, UseInfiniteQueryResult } from "./types";
import usePaginatedCore from "./use-paginated-core";
import type { PageItemOf, PaginatedArgs } from "./use-paginated-query";

/**
 * Subscribe to a reactively-paginated query and expose its pages discretely.
 *
 * Shares `usePaginatedQuery`'s reactive-pagination engine — pages are fixed
 * `(lower, upper]` cursor ranges with shared stable boundaries, so a row
 * inserted or deleted mid-list grows/shrinks the affected page without
 * duplicating or skipping rows across boundaries — but keeps each page as its
 * own inner array rather than flattening them, and adds the
 * TanStack-Query-style `fetchNextPage` / `hasNextPage` / `isFetchingNextPage`
 * shape. `fetchNextPage` appends the next page off the open-ended tail's
 * `continueCursor`; it is a no-op unless `status === "CanLoadMore"`.
 *
 * Changing `fn`, the base `args`, `initialNumItems`, or `shardKey` resets the
 * feed to its first page. The public return shape is unchanged from the legacy
 * keyset implementation.
 */
const useInfiniteQuery = <F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: UseInfiniteQueryOptions,
): UseInfiniteQueryResult<PageItemOf<F>> => {
    const { initialNumItems } = options;
    const { error, loadMore, pageResults, status } = usePaginatedCore<PageItemOf<F>>(function_, args === "skip" ? "skip" : args, options);

    const skipped = args === "skip";

    const resolvedPages: PageItemOf<F>[][] = [];

    for (const result of pageResults) {
        if (result) {
            resolvedPages.push(result.page);
        }
    }

    // `fetchNextPage` defaults to `initialNumItems` when called without a size;
    // keep both in a ref so the callback identity stays stable across renders.
    const nextRef = useRef<{ defaultNumItems: number; loadMore: (numberItems: number) => void }>({ defaultNumItems: initialNumItems, loadMore });

    // Sync the latest size + loadMore via an effect rather than a render-phase
    // ref write (which trips React Compiler). `nextRef` is read only inside the
    // user-triggered `fetchNextPage` below, so the post-commit update is always
    // current by the time it fires — and `fetchNextPage` keeps a stable identity.
    useEffect(() => {
        nextRef.current = { defaultNumItems: initialNumItems, loadMore };
    });

    // Reads only `nextRef.current` (a ref, not a reactive value), so React
    // Compiler keeps this closure stable across renders without a manual
    // `useCallback`.
    const fetchNextPage = (numberItems?: number): void => {
        const { defaultNumItems, loadMore: load } = nextRef.current;

        load(numberItems ?? defaultNumItems);
    };

    return {
        error,
        fetchNextPage,
        hasNextPage: status === "CanLoadMore",
        isFetchingNextPage: !skipped && status === "LoadingMore",
        isLoading: !skipped && status === "LoadingFirstPage",
        pages: resolvedPages,
        status,
    };
};

export default useInfiniteQuery;
