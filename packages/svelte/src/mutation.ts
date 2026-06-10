import type { ArgsOf, CirrusClient, FunctionReference, MutationCallOptions, ReturnOf } from "@cirrus/client";
import { createMutationRunner } from "@cirrus/client";
import type { Readable } from "svelte/store";
import { writable } from "svelte/store";

import { getCirrusClient } from "./context";

/**
 * The reactive handle returned by {@link mutation} — the Svelte counterpart to
 * React's `useMutation`, re-expressed as stores you read with `$`. The surface
 * is identical across the Cirrus adapters (`@cirrus/solid`, `/vue`):
 * `data`/`error`/`pending` are readable stores and `mutate` is an awaitable.
 */
export interface MutationHandle<F extends FunctionReference> {
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Readable<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Readable<Error | undefined>;
    /**
     * Run the mutation. Resolves with the server result and rejects on failure
     * (errors propagate — there is no swallowing). Optimistic updates passed in
     * `options` are applied and rolled back by the client against the live query
     * subscriptions, exactly as in the React adapter.
     */
    mutate: (args: ArgsOf<F>, options?: MutationCallOptions<unknown, unknown, ArgsOf<F>>) => Promise<ReturnOf<F>>;
    /**
     * `true` while any invocation from this handle is in flight. Ref-counted, so
     * overlapping calls compose and it only flips back to `false` once the last
     * one settles. Read it with `$pending` in a component to disable a button.
     */
    pending: Readable<boolean>;
    /** Clear `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * Create an optimistic {@link MutationHandle} for a mutation reference. The
 * Svelte counterpart to React's `useMutation`: returns
 * `{ data, error, pending, mutate, reset }` of readable stores plus an awaitable
 * `mutate`. The ref-counted pending + error-normalize orchestration is the
 * shared `createMutationRunner` from `@cirrus/client`; only the stores are
 * adapter-specific.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setCirrusClient`.
 */
export function mutation<F extends FunctionReference>(function_: F): MutationHandle<F>;
export function mutation<F extends FunctionReference>(client: CirrusClient, function_: F): MutationHandle<F>;
export function mutation<F extends FunctionReference>(clientOrFunction: CirrusClient | F, maybeFunction?: F): MutationHandle<F> {
    const hasExplicitClient = maybeFunction !== undefined;
    const client = hasExplicitClient ? (clientOrFunction as CirrusClient) : getCirrusClient();
    const functionRef = (hasExplicitClient ? maybeFunction : clientOrFunction) as F;

    const data = writable<ReturnOf<F> | undefined>(undefined);
    const error = writable<Error | undefined>(undefined);
    const pending = writable(false);

    const mutate = createMutationRunner<F>(client, functionRef, {
        setError: (next) => error.set(next),
        setPending: (next) => pending.set(next),
        setResult: (result) => {
            data.set(result);
            error.set(undefined);
        },
    });

    const reset = (): void => {
        data.set(undefined);
        error.set(undefined);
    };

    return { data, error, mutate, pending, reset };
}
