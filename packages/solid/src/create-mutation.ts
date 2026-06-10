import type { ArgsOf, FunctionReference, OptimisticUpdate, ReturnOf } from "@cirrus/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useCirrus } from "./context";

/** Per-call options forwarded straight to `client.mutation`. */
export interface CreateMutationCallOptions<TCurrent = unknown, TValue = unknown, TArgs = unknown> {
    /**
     * Single-subscription optimistic transform. Receives the matching
     * subscription's current value and returns the value to show until the
     * server confirms; rolled back on failure.
     */
    optimistic?: (current: TCurrent | undefined) => TValue;

    /**
     * Convex-parity multi-query optimistic update over the live subscription
     * cache. One mutation can patch many subscribed queries at once; every write
     * is rolled back atomically if the mutation rejects.
     */
    optimisticUpdate?: OptimisticUpdate<TArgs>;

    /** Route to a specific shard when the target mutation is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

export interface MutationHandle<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Accessor<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Accessor<Error | undefined>;
    /** Invoke the mutation. Resolves with the server result; rejects on failure. */
    mutate: (args: ArgsOf<F>, options?: CreateMutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
    /** `true` while any invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Accessor<boolean>;
    /** Clear `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * The transport surface {@link createMutation} actually needs — just
 * `client.mutation`. Narrowed so the primitive can be exercised against a stub
 * in tests without constructing a full `CirrusClient`.
 */
export interface MutationClient<F extends FunctionReference> {
    mutation: (function_: F, args: ArgsOf<F>, options?: CreateMutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
}

/**
 * Build a mutation handle bound to an explicit client. Internal seam used by the
 * provider-bound {@link createMutation}; exported for tests that inject a stub.
 */
export const createMutationForClient = <F extends FunctionReference>(client: MutationClient<F>, function_: F): MutationHandle<F> => {
    const [data, setData] = createSignal<ReturnOf<F> | undefined>(undefined);
    const [error, setError] = createSignal<Error | undefined>(undefined);
    const [pending, setPending] = createSignal(false);

    // Ref-counted across overlapping calls of this handle instance.
    let inFlight = 0;

    const mutate = async (args: ArgsOf<F>, options?: CreateMutationCallOptions<unknown, unknown, ArgsOf<F>>): Promise<ReturnOf<F>> => {
        inFlight += 1;
        setPending(true);

        try {
            const result = await client.mutation(function_, args, options);

            // Wrap in a thunk so a function-valued server result is stored, not invoked.
            setData(() => result);
            setError(undefined);

            return result;
        } catch (error_) {
            const normalized = error_ instanceof Error ? error_ : new Error(String(error_));

            setError(normalized);

            throw normalized;
        } finally {
            inFlight -= 1;
            setPending(inFlight > 0);
        }
    };

    const reset = (): void => {
        setData(() => undefined);
        setError(undefined);
    };

    return { data, error, mutate, pending, reset };
};

/**
 * Returns a reactive handle `{ mutate, pending, data, error, reset }` for the
 * given mutation reference, bound to the `CirrusClient` from the nearest
 * `&lt;CirrusProvider>`.
 *
 * Optimistic updates stay client-owned: the `optimistic` / `optimisticUpdate`
 * call options pass straight through to `client.mutation`, which applies and
 * rolls them back against the live Cirrus subscription cache — the same
 * machinery `createQuery`/`hydratePreloaded` subscribe to, so an optimistic
 * write reflects in those accessors immediately and reverts on failure.
 *
 * `pending` is ref-counted across overlapping invocations of *this* handle, so
 * it only flips back to `false` once every concurrent call has settled. The
 * mutation also engages `@cirrus/client`'s offline queue when the socket is
 * down, so `mutate` stays durable across reconnects.
 */
export const createMutation = <F extends FunctionReference>(function_: F): MutationHandle<F> => {
    const client = useCirrus();

    return createMutationForClient<F>(
        {
            mutation: (reference, args, options) => client.mutation(reference, args, options),
        },
        function_,
    );
};
