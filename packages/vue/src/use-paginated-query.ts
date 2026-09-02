import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import type { PaginationStatus } from "@lunora/client/pagination";
import type { MaybeRefOrGetter, Ref } from "vue";
import { computed } from "vue";

import { usePaginatedCore } from "./use-paginated-core";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F extends FunctionReference> = Omit<ArgsOf<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F extends FunctionReference> = ReturnOf<F> extends { page: (infer T)[] } ? T : unknown;

interface UsePaginatedQueryOptions {
    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;
    /** Called when a page subscription reports an error (also surfaced on the `error` ref). */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

interface UsePaginatedQueryResult<T> {
    /**
     * The last page subscription error, or `undefined`. A tail page that fails
     * before its first frame is dropped so `status` returns to `"CanLoadMore"`
     * and `loadMore` can retry it; cleared by the next successful frame,
     * `loadMore`, or an args change.
     */
    error: Ref<SubscriptionError | undefined>;
    /** `true` while the first page or a `loadMore` page is in flight. */
    isLoading: Ref<boolean>;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Flattened items across every loaded page, in order. */
    results: Ref<T[]>;
    status: Ref<PaginationStatus>;
}

/**
 * Subscribe to a reactively-paginated query and grow the feed page by page.
 *
 * The query function must accept a `paginationOpts: { numItems, cursor,
 * endCursor }` arg and return a `PaginationResult`. Pages are tracked as an
 * ordered list of stable boundary cursors; each loaded page is a live
 * subscription over a FIXED `(lower, upper]` range. Inserting or deleting a row
 * grows/shrinks the affected page without duplicating or skipping rows across
 * boundaries.
 *
 * `loadMore` appends the next page off the open-ended tail's `continueCursor`;
 * it is a no-op unless `status === "CanLoadMore"`. Background split/join
 * maintenance keeps page sizes near `initialNumItems` as edits accumulate.
 *
 * Changing `fn`, the base `args`, `initialNumItems`, or `shardKey` resets the
 * feed to its first page.
 *
 * Call inside `setup()` (or any active effect scope).
 */
const usePaginatedQuery = <F extends FunctionReference>(
    function_: F,
    args: MaybeRefOrGetter<"skip" | PaginatedArgs<F>>,
    options: UsePaginatedQueryOptions,
): UsePaginatedQueryResult<PageItemOf<F>> => {
    const { error, loadMore, pageResults, status } = usePaginatedCore<PageItemOf<F>>(function_, args, options);

    const results = computed<PageItemOf<F>[]>(() => pageResults.value.flatMap((result) => result?.page ?? []));

    const isLoading = computed<boolean>(() => status.value === "LoadingFirstPage" || status.value === "LoadingMore");

    return { error, isLoading, loadMore, results, status };
};

interface UseInfiniteQueryOptions {
    /** Page size for the first page (and the default for `fetchNextPage`). */
    initialNumItems: number;
    /** Called when a page subscription reports an error (also surfaced on the `error` ref). */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

interface UseInfiniteQueryResult<T> {
    /** The last page subscription error, or `undefined` — see `UsePaginatedQueryResult.error`. */
    error: Ref<SubscriptionError | undefined>;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    fetchNextPage: (numberItems?: number) => void;
    /** `true` when the loaded tail reports it can load another page. */
    hasNextPage: Ref<boolean>;
    /** `true` while a `fetchNextPage` page (beyond the first) is in flight. */
    isFetchingNextPage: Ref<boolean>;
    /** `true` while the first page is in flight. */
    isLoading: Ref<boolean>;
    /** One inner array per loaded page, in order; unresolved pages are omitted. */
    pages: Ref<T[][]>;
    status: Ref<PaginationStatus>;
}

/**
 * Subscribe to a reactively-paginated query and expose its pages discretely.
 *
 * Shares `usePaginatedQuery`'s reactive-pagination engine but keeps each page
 * as its own inner array rather than flattening them, and adds the
 * TanStack-Query-style `fetchNextPage` / `hasNextPage` / `isFetchingNextPage`
 * shape.
 *
 * Call inside `setup()` (or any active effect scope).
 */
const useInfiniteQuery = <F extends FunctionReference>(
    function_: F,
    args: MaybeRefOrGetter<"skip" | PaginatedArgs<F>>,
    options: UseInfiniteQueryOptions,
): UseInfiniteQueryResult<PageItemOf<F>> => {
    const { initialNumItems } = options;
    const { error, loadMore, pageResults, status } = usePaginatedCore<PageItemOf<F>>(function_, args, options);

    const pages = computed<PageItemOf<F>[][]>(() => pageResults.value.flatMap((result) => (result ? [result.page] : [])));

    const isLoading = computed<boolean>(() => status.value === "LoadingFirstPage");
    const hasNextPage = computed<boolean>(() => status.value === "CanLoadMore");
    const isFetchingNextPage = computed<boolean>(() => status.value === "LoadingMore");

    const fetchNextPage = (numberItems?: number): void => {
        loadMore(numberItems ?? initialNumItems);
    };

    return { error, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, pages, status };
};

export type { PageItemOf, PaginatedArgs, UseInfiniteQueryOptions, UseInfiniteQueryResult, UsePaginatedQueryOptions, UsePaginatedQueryResult };
export { useInfiniteQuery, usePaginatedQuery };
