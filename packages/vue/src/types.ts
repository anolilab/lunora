/** Options shared by the live-query composables. */
export interface UseQueryOptions {
    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

export {
    type ArgsOf,
    type CirrusClient,
    type FunctionReference,
    type MutationCallOptions,
    type OptimisticLocalStore,
    type OptimisticUpdate,
    type Preloaded,
    type ReturnOf,
    type Unsubscribe,
    type User,
} from "@cirrus/client";
