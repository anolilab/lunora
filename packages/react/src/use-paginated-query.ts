"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";

import type { UsePaginatedQueryOptions, UsePaginatedQueryResult } from "./types";
import usePaginatedCore from "./use-paginated-core";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F> = Omit<ArgsOf<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F> = ReturnOf<F> extends { page: (infer T)[] } ? T : unknown;

/**
 * Subscribe to a reactively-paginated query and grow the feed page by page.
 *
 * Pass `onError` (and read `error`) to see a page failure: without it the hook
 * only reports `status`, and a first page that fails reads as an eternal
 * `isLoading`.
 *
 * The query function must accept a `paginationOpts: { numItems, cursor,
 * endCursor }` arg and return a `PaginationResult` (the shape
 * `ctx.db.query(...).paginate` yields). Pages are tracked as an ordered list of
 * stable boundary cursors: each loaded page is a live subscription over a
 * FIXED `(lower, upper]` range whose upper bound is the next page's lower bound.
 * Because boundaries are shared stable cursors, inserting or deleting a row in
 * the middle of the list grows/shrinks the affected page in place without
 * duplicating or skipping rows across page boundaries — the bug the legacy
 * "first N after the previous page's last row" model suffered under live edits.
 *
 * `loadMore` appends the next page off the open-ended tail's `continueCursor`;
 * it is a no-op unless `status === "CanLoadMore"`. Background split/join
 * maintenance keeps page sizes near `initialNumItems` as edits accumulate (see
 * `use-paginated-core.ts`).
 *
 * Changing `fn`, the base `args`, `initialNumItems`, or `shardKey` resets the
 * feed to its first page. The public return shape (`results` / `status` /
 * `loadMore`) is unchanged from the legacy keyset implementation.
 */
const usePaginatedQuery = <F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: UsePaginatedQueryOptions,
): UsePaginatedQueryResult<PageItemOf<F>> => {
    const { error, loadMore, pageResults, status } = usePaginatedCore<PageItemOf<F>>(function_, args === "skip" ? "skip" : args, options);

    const results: PageItemOf<F>[] = [];

    for (const result of pageResults) {
        if (result) {
            results.push(...result.page);
        }
    }

    const skipped = args === "skip";

    return {
        error,
        isLoading: !skipped && (status === "LoadingFirstPage" || status === "LoadingMore"),
        loadMore,
        results,
        status,
    };
};

export type { PageItemOf, PaginatedArgs };
export { usePaginatedQuery };
