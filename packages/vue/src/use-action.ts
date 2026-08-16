import type { ActionCallOptions, ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createActionRunner } from "@lunora/client";
import type { Ref } from "vue";
import { ref, shallowRef } from "vue";

import { useLunora } from "./lunora-provider";

/**
 * The reactive handle returned by {@link useAction} — the Vue counterpart to
 * React's `useAction`, re-expressed with refs. The surface is identical across
 * the Lunora adapters (`@lunora/solid`, `/svelte`): `data`/`error`/`pending`
 * are refs you read in a template, and `call` is an awaitable that resolves with
 * the server value (or rejects).
 */
export interface ActionHandle<F extends FunctionReference> {
    /** Invoke the action. Resolves with the server value; rejects on failure. */
    call: (args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Ref<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Ref<Error | undefined>;
    /** `true` while ANY invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Ref<boolean>;
    /** Clear the latest `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * Returns a reactive {@link ActionHandle} for the given action reference — the
 * Vue equivalent of React's `useAction`.
 *
 * Actions were the one procedure kind with no adapter hook: `useQuery` and
 * `useMutation` shipped in every adapter and nothing covered actions, so each
 * app re-derived the same pending/error wrapper by hand.
 *
 * **Narrower than `useMutation` on purpose:** there are no `optimistic` /
 * `optimisticUpdate` call options. An optimistic update patches the subscription
 * cache on the assumption a write will land; an action is not a write — it runs
 * in the Worker, may call a third party, and has no declared effect on any
 * query. Offering the option would imply a rollback guarantee nothing can
 * honour.
 *
 * `pending` is ref-counted across overlapping invocations of THIS handle, so it
 * flips back to `false` only once every concurrent call has settled. That
 * orchestration is the shared `createActionRunner` from `@lunora/client`; only
 * the refs are adapter-specific.
 */
export const useAction = <F extends FunctionReference>(function_: F): ActionHandle<F> => {
    const client = useLunora();

    const data = shallowRef<ReturnOf<F> | undefined>(undefined) as Ref<ReturnOf<F> | undefined>;
    const error = shallowRef<Error | undefined>(undefined);
    const pending = ref(false);

    const reset = (): void => {
        data.value = undefined;
        error.value = undefined;
    };

    const call = createActionRunner<F>(client, function_, {
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

    return { call, data, error, pending, reset };
};
