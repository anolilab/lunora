import type { OptimisticUpdate, SubscriptionError, SubscriptionErrorCallback, User } from "@lunora/client";
import type { PaginationStatus } from "@lunora/client/pagination";

export interface UseQueryOptions {
    /**
     * Called when the server pushes a subscription-scoped error (an RLS denial, a
     * query that starts failing server-side). Without a handler such an error has
     * nowhere to go and the hook's value simply freezes at its last good result.
     */
    onError?: SubscriptionErrorCallback;
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

    /** Called when a page subscription (or its initial fetch) fails; also surfaced on `error`. */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

export interface UsePaginatedQueryResult<T> {
    /**
     * The last page failure, or `undefined`. A tail page that fails before its
     * first frame is dropped so `status` returns to `"CanLoadMore"` and
     * `loadMore` can retry it; the first page has nothing to fall back to and
     * stays `"LoadingFirstPage"` with this set. Cleared by the next successful
     * frame, by `loadMore`, or by an args change.
     */
    error: SubscriptionError | undefined;
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

    /** Called when a page subscription (or its initial fetch) fails; also surfaced on `error`. */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

export interface UseInfiniteQueryResult<T> {
    /** The last page failure, or `undefined` — see `UsePaginatedQueryResult.error`. */
    error: SubscriptionError | undefined;
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
    type AuthImpersonation,
    type AuthPage,
    type AuthSession,
    type AuthUser,
    type FunctionReference,
    type HttpStreamArgsOf,
    type HttpStreamChunkOf,
    type HttpStreamRef,
    type LunoraClient,
    type OptimisticLocalStore,
    type OptimisticUpdate,
    type Preloaded,
    type ReturnOf,
    type SubscriptionError,
    type SubscriptionErrorCallback,
    type User,
} from "@lunora/client";
export { type PaginationResult, type PaginationStatus } from "@lunora/client/pagination";
