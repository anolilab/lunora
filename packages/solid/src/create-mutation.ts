import type { ArgsOf, FunctionReference, MutationCallOptions, ReturnOf } from "@lunora/client";
import { createMutationRunner } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";

export interface MutationHandle<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Accessor<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Accessor<Error | undefined>;
    /** Invoke the mutation. Resolves with the server result; rejects on failure. */
    mutate: (args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
    /** `true` while any invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Accessor<boolean>;
    /** Clear `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * The transport surface {@link createMutation} actually needs — just
 * `client.mutation`. Narrowed so the primitive can be exercised against a stub
 * in tests without constructing a full `LunoraClient`.
 */
export interface MutationClient<F extends FunctionReference> {
    mutation: (function_: F, args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
}

/**
 * Build a mutation handle bound to an explicit client. Internal seam used by the
 * provider-bound {@link createMutation}; exported for tests that inject a stub.
 * The ref-counted pending + error-normalize orchestration is the shared
 * `createMutationRunner` from `@lunora/client`; only the reactive sinks (Solid
 * signals) are adapter-specific.
 */
export const createMutationForClient = <F extends FunctionReference>(client: MutationClient<F>, function_: F): MutationHandle<F> => {
    const [data, setData] = createSignal<ReturnOf<F> | undefined>(undefined);
    const [error, setError] = createSignal<Error | undefined>(undefined);
    const [pending, setPending] = createSignal(false);

    const mutate = createMutationRunner(client, function_, {
        setError,
        setPending,
        setResult: (result) => {
            // Wrap in a thunk so a function-valued server result is stored, not invoked.
            setData(() => result);
            setError(undefined);
        },
    });

    const reset = (): void => {
        setData(() => undefined);
        setError(undefined);
    };

    return { data, error, mutate, pending, reset };
};

/**
 * Returns a reactive handle `{ mutate, pending, data, error, reset }` for the
 * given mutation reference, bound to the `LunoraClient` from the nearest
 * `<LunoraProvider>`.
 *
 * Optimistic updates stay client-owned: the `optimistic` / `optimisticUpdate`
 * call options pass straight through to `client.mutation`, which applies and
 * rolls them back against the live Lunora subscription cache — the same
 * machinery `createQuery`/`hydratePreloaded` subscribe to, so an optimistic
 * write reflects in those accessors immediately and reverts on failure.
 *
 * `pending` is ref-counted across overlapping invocations of *this* handle, so
 * it only flips back to `false` once every concurrent call has settled. The
 * mutation also engages `@lunora/client`'s offline queue when the socket is
 * down, so `mutate` stays durable across reconnects.
 */
export const createMutation = <F extends FunctionReference>(function_: F): MutationHandle<F> => {
    const client = useLunora();

    return createMutationForClient<F>(
        {
            mutation: (reference, args, options) => client.mutation(reference, args, options),
        },
        function_,
    );
};
