import type { OptimisticUpdate, User } from "@lunora/client";
import type { PaginationStatus } from "@lunora/client/pagination";

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
    type FunctionReference,
    type HttpStreamArgsOf,
    type HttpStreamChunkOf,
    type HttpStreamRef,
    type LunoraClient,
    type OptimisticLocalStore,
    type OptimisticUpdate,
    type Preloaded,
    type ReturnOf,
    type User,
} from "@lunora/client";
export { type PaginationResult, type PaginationStatus } from "@lunora/client/pagination";
