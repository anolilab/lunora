import type { ArgsOf, FunctionReference, MutationCallOptions, ReturnOf } from "@lunora/client";
import { createMutationRunner } from "@lunora/client";
import type { Ref } from "vue";
import { ref, shallowRef } from "vue";

import { useLunora } from "./lunora-provider";

/**
 * The reactive handle returned by {@link useMutation} — the Vue counterpart to
 * React's `useMutation`, re-expressed with refs. The surface is identical across
 * the Lunora adapters (`@lunora/solid`, `/svelte`): `data`/`error`/`pending` are
 * refs you read in a template, `mutate` is an awaitable that resolves with the
 * server value (or rejects). Per-call `optimistic` / `optimisticUpdate` options
 * pass straight through to `client.mutation`.
 */
export interface MutationHandle<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Ref<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Ref<Error | undefined>;
    /** Invoke the mutation. Resolves with the server value; rejects on failure. */
    mutate: (args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Ref<boolean>;
    /** Clear the latest `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * Returns a reactive {@link MutationHandle} for the given mutation reference —
 * the Vue equivalent of React's `useMutation`.
 *
 * Optimistic updates stay client-owned: the `optimistic` / `optimisticUpdate`
 * call options pass straight through to `client.mutation`, which applies and
 * rolls them back against the Lunora subscription cache (Convex parity).
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * flips back to `false` only once every concurrent call has settled. The
 * ref-counted pending + error-normalize orchestration is the shared
 * `createMutationRunner` from `@lunora/client`; only the refs are
 * adapter-specific.
 */
export const useMutation = <F extends FunctionReference>(function_: F): MutationHandle<F> => {
    const client = useLunora();

    const data = shallowRef<ReturnOf<F> | undefined>(undefined) as Ref<ReturnOf<F> | undefined>;
    const error = shallowRef<Error | undefined>(undefined);
    const pending = ref(false);

    const reset = (): void => {
        data.value = undefined;
        error.value = undefined;
    };

    const mutate = createMutationRunner<F>(client, function_, {
        setError: (next) => {
            error.value = next;
        },
        setPending: (next) => {
            pending.value = next;
        },
        setResult: (result) => {
            data.value = result;
            error.value = undefined;
        },
    });

    return { data, error, mutate, pending, reset };
};
