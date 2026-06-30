import { applyOptimisticLayer } from "./optimistic-layers";
import type { SubscriptionRegistry, SubscriptionState } from "./subscription";
import type { ArgsOf, FunctionReference, ReturnOf } from "./types";

/**
 * Read/write handle over the client's live query cache, handed to a mutation's
 * `withOptimisticUpdate` callback so a single mutation can optimistically patch
 * many subscribed queries at once (Convex's `OptimisticLocalStore` model).
 *
 * `getQuery` reads the current value (server value or any still-pending
 * optimistic override) of a subscribed query; `setQuery` registers a constant
 * optimistic layer on top. The whole batch rebases onto incoming deltas and
 * settles together — confirmed on the mutation's commit cursor, or rolled back
 * on failure — the same per-subscription layer machinery the single-query
 * per-call `optimistic` transform uses, generalized to N queries.
 */
export interface OptimisticLocalStore {
    /**
     * Every loaded subscription on `function_`, regardless of args, paired with
     * the args it was subscribed under. Mirrors Convex's `getAllQueries` — handy
     * when a write must patch every variant of a list query (all channels,
     * all filters) without enumerating their args up front.
     */
    getAllQueries: <F extends FunctionReference>(function_: F) => { args: ArgsOf<F>; value: ReturnOf<F> | undefined }[];

    /**
     * Current cached value for the subscribed `(function_, args)` query, or
     * `undefined` when nothing is subscribed/loaded for it. Reflects any
     * optimistic override already written in this batch.
     */
    getQuery: <F extends FunctionReference>(function_: F, args: ArgsOf<F>) => ReturnOf<F> | undefined;

    /**
     * Write an optimistic override for the subscribed `(function_, args)`
     * query. A no-op (returns without effect) when no subscription matches —
     * mirroring Convex, where you only patch queries the page is watching.
     */
    setQuery: <F extends FunctionReference>(function_: F, args: ArgsOf<F>, value: ReturnOf<F> | undefined) => void;
}

/** A mutation's multi-query optimistic update: read/write the cache via `localStore`. */
export type OptimisticUpdate<Args> = (localStore: OptimisticLocalStore, args: Args) => void;

/**
 * Build an {@link OptimisticLocalStore} bound to a subscription registry and the
 * mutation's shard key. Each `setQuery(value)` registers a constant-value layer
 * on its target subscription (via `applyOptimisticLayer`): the predicted value
 * survives incoming server deltas (re-clamped, masking concurrent changes to that
 * query — not merged) and drops gaplessly on the mutation's commit cursor, like
 * the single-query per-call `optimistic` path. Returns the store plus the ordered
 * `confirm` (success) and `rollback` (failure) closures every `setQuery` produced,
 * so the caller settles the whole batch when the mutation does.
 */
export const createLocalStore = (
    subscriptions: SubscriptionRegistry,
    shardKey: string | undefined,
    stableStringify: (value: unknown) => string,
): { confirms: ((commitCursor: number | undefined) => void)[]; rollbacks: (() => void)[]; store: OptimisticLocalStore } => {
    const confirms: ((commitCursor: number | undefined) => void)[] = [];
    const rollbacks: (() => void)[] = [];

    // Resolve the live subscription for one (fn, args) pair on the mutation's
    // shard. Subscriptions are keyed by stable-stringified args, so an
    // optimistic patch only lands on the exact query variant it names.
    const findState = (functionRef: string, argsKey: string): SubscriptionState | undefined => {
        for (const state of subscriptions.all()) {
            if (state.fn.__lunoraRef === functionRef && state.shardKey === shardKey && state.argsKey === argsKey) {
                return state;
            }
        }

        return undefined;
    };

    const store: OptimisticLocalStore = {
        getAllQueries: <F extends FunctionReference>(function_: F): { args: ArgsOf<F>; value: ReturnOf<F> | undefined }[] => {
            const matches: { args: ArgsOf<F>; value: ReturnOf<F> | undefined }[] = [];

            for (const state of subscriptions.all()) {
                if (state.fn.__lunoraRef === function_.__lunoraRef && state.shardKey === shardKey) {
                    matches.push({ args: state.args as ArgsOf<F>, value: state.lastValue as ReturnOf<F> | undefined });
                }
            }

            return matches;
        },
        getQuery: <F extends FunctionReference>(function_: F, args: ArgsOf<F>): ReturnOf<F> | undefined => {
            const state = findState(function_.__lunoraRef, stableStringify(args ?? {}));

            return state?.lastValue as ReturnOf<F> | undefined;
        },
        setQuery: <F extends FunctionReference>(function_: F, args: ArgsOf<F>, value: ReturnOf<F> | undefined): void => {
            const state = findState(function_.__lunoraRef, stableStringify(args ?? {}));

            if (!state) {
                return;
            }

            const handle = applyOptimisticLayer(state, () => value);

            if (handle) {
                confirms.push(handle.confirm);
                rollbacks.push(handle.rollback);
            }
        },
    };

    return { confirms, rollbacks, store };
};
