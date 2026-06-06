import type { SubscriptionRegistry, SubscriptionState } from "./subscription.js";
import type { ArgsOf, FunctionReference, ReturnOf } from "./types.js";

/**
 * Read/write handle over the client's live query cache, handed to a mutation's
 * `withOptimisticUpdate` callback so a single mutation can optimistically patch
 * many subscribed queries at once (Convex's `OptimisticLocalStore` model).
 *
 * `getQuery` reads the current value (server value or any still-pending
 * optimistic override) of a subscribed query; `setQuery` writes an optimistic
 * override on top. Every write is collected as a rollback closure so the whole
 * batch unwinds atomically when the mutation settles or the server advances
 * past it — the same per-subscription rollback machinery the legacy
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
 * Build an {@link OptimisticLocalStore} bound to a subscription registry, the
 * mutation's shard key, and the `writeOptimisticToState` primitive. Returns the
 * store plus the ordered rollback closures every `setQuery` produced, so the
 * caller can unwind the whole batch (LIFO) if the mutation later fails — and
 * leave them in place to be GC'd alongside the subscription on success.
 */
export const createLocalStore = (
    subscriptions: SubscriptionRegistry,
    shardKey: string | undefined,
    write: (state: SubscriptionState, next: unknown) => () => void,
    stableStringify: (value: unknown) => string,
): { rollbacks: (() => void)[]; store: OptimisticLocalStore } => {
    const rollbacks: (() => void)[] = [];

    // Resolve the live subscription for one (fn, args) pair on the mutation's
    // shard. Subscriptions are keyed by stable-stringified args, so an
    // optimistic patch only lands on the exact query variant it names.
    const findState = (functionRef: string, argsKey: string): SubscriptionState | undefined => {
        for (const state of subscriptions.all()) {
            if (state.fn.__cirrusRef === functionRef && state.shardKey === shardKey && state.argsKey === argsKey) {
                return state;
            }
        }

        return undefined;
    };

    const store: OptimisticLocalStore = {
        getAllQueries: <F extends FunctionReference>(function_: F): { args: ArgsOf<F>; value: ReturnOf<F> | undefined }[] => {
            const matches: { args: ArgsOf<F>; value: ReturnOf<F> | undefined }[] = [];

            for (const state of subscriptions.all()) {
                if (state.fn.__cirrusRef === function_.__cirrusRef && state.shardKey === shardKey) {
                    matches.push({ args: state.args as ArgsOf<F>, value: state.lastValue as ReturnOf<F> | undefined });
                }
            }

            return matches;
        },
        getQuery: <F extends FunctionReference>(function_: F, args: ArgsOf<F>): ReturnOf<F> | undefined => {
            const state = findState(function_.__cirrusRef, stableStringify(args ?? {}));

            return state?.lastValue as ReturnOf<F> | undefined;
        },
        setQuery: <F extends FunctionReference>(function_: F, args: ArgsOf<F>, value: ReturnOf<F> | undefined): void => {
            const state = findState(function_.__cirrusRef, stableStringify(args ?? {}));

            if (!state) {
                return;
            }

            rollbacks.push(write(state, value));
        },
    };

    return { rollbacks, store };
};
