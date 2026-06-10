import type { OptimisticUpdate } from "@cirrus/client";

/** Options shared by the live-query composables. */
export interface UseQueryOptions {
    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/** Per-call options for a mutation handle's `mutate`. */
export interface UseMutationCallOptions<TCurrent = unknown, TValue = unknown, TArgs = unknown> {
    /** Legacy single-query optimistic transform applied to the matching `(fn, args, shard)` subscription. */
    optimistic?: (current: TCurrent | undefined) => TValue;

    /**
     * Convex-parity multi-query optimistic update forwarded to
     * `client.mutation`. Patches many subscribed queries at once via an
     * `OptimisticLocalStore`, rolled back atomically on failure.
     */
    optimisticUpdate?: OptimisticUpdate<TArgs>;
    shardKey?: string;
}

export {
    type ArgsOf,
    type CirrusClient,
    type FunctionReference,
    type OptimisticLocalStore,
    type OptimisticUpdate,
    type Preloaded,
    type ReturnOf,
    type Unsubscribe,
    type User,
} from "@cirrus/client";
