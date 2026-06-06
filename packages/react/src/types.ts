import type { OptimisticUpdate, User } from "@cirrus/client";

export interface UseQueryOptions {
    shardKey?: string;
}

export interface UseMutationCallOptions<TCurrent = unknown, TValue = unknown, TArgs = unknown> {
    optimistic?: (current: TCurrent | undefined) => TValue;

    /**
     * Convex-parity multi-query optimistic update forwarded to
     * `client.mutation`. Patches many subscribed queries at once via an
     * `OptimisticLocalStore`, rolled back atomically on failure.
     */
    optimisticUpdate?: OptimisticUpdate<TArgs>;
    shardKey?: string;
}

export interface UseSubscriptionResult<T> {
    data: T | undefined;
    error: Error | undefined;
}

/** One page returned by a paginated query — the shape `.paginate()` yields. */
export interface PaginationResult<T = unknown> {
    continueCursor: null | string;
    isDone: boolean;
    page: T[];

    /**
     * Reactive-pagination only: the midpoint cursor of a bounded
     * `(cursor, endCursor]` page, used to split an over-grown page into two
     * adjacent ranges. Absent on legacy (open-ended) pages.
     */
    splitCursor?: null | string;
}

/**
 * Lifecycle of a `usePaginatedQuery` feed.
 *
 * - `LoadingFirstPage` — the first page is in flight; `results` is empty.
 * - `CanLoadMore` — the loaded tail has a cursor; calling `loadMore` fetches the next page.
 * - `LoadingMore` — a `loadMore` page is in flight; earlier results stay visible.
 * - `Exhausted` — every page has loaded and the server reported `isDone`.
 */
export type PaginationStatus = "CanLoadMore" | "Exhausted" | "LoadingFirstPage" | "LoadingMore";

export interface UsePaginatedQueryOptions {
    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;
    shardKey?: string;
}

export interface UsePaginatedQueryResult<T> {
    /** `true` while the first page or a `loadMore` page is in flight. */
    isLoading: boolean;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Flattened items across every loaded page, in order. */
    results: T[];
    status: PaginationStatus;
}

export interface UseInfiniteQueryOptions {
    /** Page size for the first page (and the default for `fetchNextPage`). */
    initialNumItems: number;
    shardKey?: string;
}

export interface UseInfiniteQueryResult<T> {
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    fetchNextPage: (numberItems?: number) => void;
    /** `true` when the loaded tail reports it can load another page. */
    hasNextPage: boolean;
    /** `true` while a `fetchNextPage` page (beyond the first) is in flight. */
    isFetchingNextPage: boolean;
    /** `true` while the first page is in flight. */
    isLoading: boolean;
    /** One inner array per loaded page, in order; unresolved pages are omitted. */
    pages: T[][];
    status: PaginationStatus;
}

export interface UseAuthResult {
    setToken: (token: string | null) => void;
    token: string | null;
    user: User | null;
}

export {
    type ArgsOf,
    type CirrusClient,
    type FunctionReference,
    type OptimisticLocalStore,
    type OptimisticUpdate,
    type Preloaded,
    type ReturnOf,
    type User,
} from "@cirrus/client";
