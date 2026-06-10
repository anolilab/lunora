import type { ArgsOf, FunctionReference, OptimisticUpdate, ReturnOf } from "@cirrus/client";
import type { Ref } from "vue";
import { ref, shallowRef } from "vue";

import { useCirrusClient } from "./cirrus-provider";
import type { UseMutationCallOptions } from "./types";

type CallOptions<F extends FunctionReference> = UseMutationCallOptions<unknown, unknown, ArgsOf<F>>;

/**
 * The reactive handle returned by {@link useMutation}. Mirrors React's
 * `MutationHook` contract, re-expressed with Vue refs: `pending`/`data`/`error`
 * are refs you read in a template, `mutate` is an awaitable that resolves with
 * the server value (or rejects).
 */
export interface MutationHandle<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Ref<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Ref<Error | undefined>;
    /** Invoke the mutation. Resolves with the server value; rejects on failure. */
    mutate: (args: ArgsOf<F>, options?: CallOptions<F>) => Promise<ReturnOf<F>>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Ref<boolean>;
    /** Clear the latest `data`/`error` back to idle. */
    reset: () => void;

    /**
     * Bind a Convex-parity multi-query optimistic update to this mutation.
     * Returns a handle whose `mutate` forwards `update` as the `optimisticUpdate`
     * for every call — unless a per-call `optimisticUpdate` overrides it.
     */
    withOptimisticUpdate: (update: OptimisticUpdate<ArgsOf<F>>) => MutationHandle<F>;
}

/**
 * Returns a reactive {@link MutationHandle} for the given mutation reference —
 * the Vue equivalent of React's `useMutation`.
 *
 * Optimistic updates stay client-owned: the `optimistic` / `optimisticUpdate`
 * call options pass straight through to `client.mutation`, which applies and
 * rolls them back against the Cirrus subscription cache (Convex parity).
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * flips back to `false` only once every concurrent call has settled.
 */
export const useMutation = <F extends FunctionReference>(function_: F): MutationHandle<F> => {
    const client = useCirrusClient();

    const data = shallowRef<ReturnOf<F> | undefined>(undefined) as Ref<ReturnOf<F> | undefined>;
    const error = shallowRef<Error | undefined>(undefined);
    const pending = ref(false);

    let pendingCount = 0;

    const reset = (): void => {
        data.value = undefined;
        error.value = undefined;
    };

    const makeMutate =
        (boundUpdate?: OptimisticUpdate<ArgsOf<F>>) =>
        async (args: ArgsOf<F>, options?: CallOptions<F>): Promise<ReturnOf<F>> => {
            // Bound update is the default; a per-call `optimisticUpdate` overrides it.
            const callOptions: CallOptions<F> = boundUpdate ? { optimisticUpdate: boundUpdate, ...options } : (options ?? {});

            pendingCount += 1;
            pending.value = true;

            try {
                const result = await client.mutation(function_, args, callOptions);

                data.value = result;
                error.value = undefined;

                return result;
            } catch (error_) {
                error.value = error_ instanceof Error ? error_ : new Error(String(error_));

                throw error_;
            } finally {
                pendingCount -= 1;
                pending.value = pendingCount > 0;
            }
        };

    const build = (boundUpdate?: OptimisticUpdate<ArgsOf<F>>): MutationHandle<F> => {
        return {
            data,
            error,
            mutate: makeMutate(boundUpdate),
            pending,
            reset,
            withOptimisticUpdate: (update) => build(update),
        };
    };

    return build();
};
