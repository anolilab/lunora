import type { SubscriptionErrorCallback } from "@lunora/client";

/** Options shared by the live-query composables. */
export interface UseQueryOptions {
    /**
     * Called when the server pushes a subscription-scoped error (an RLS denial, a
     * query that starts failing server-side). Without a handler such an error has
     * nowhere to go and the ref simply freezes at its last good value.
     */
    onError?: SubscriptionErrorCallback;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

export {
    type ArgsOf,
    type FunctionReference,
    type LunoraClient,
    type MutationCallOptions,
    type OptimisticLocalStore,
    type OptimisticUpdate,
    type Preloaded,
    type ReturnOf,
    type SubscriptionError,
    type SubscriptionErrorCallback,
    type Unsubscribe,
    type User,
} from "@lunora/client";
export { type PaginationResult, type PaginationStatus } from "@lunora/client/pagination";
