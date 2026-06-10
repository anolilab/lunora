import type { ArgsOf, CirrusClient, FunctionReference, ReturnOf } from "@cirrus/client";
import type { Readable } from "svelte/store";
import { writable } from "svelte/store";

import { getCirrusClient } from "./context";

/**
 * Per-call options forwarded straight to `CirrusClient.mutation` — including the
 * optimistic-update machinery (`optimistic` / `optimisticUpdate`) and `shardKey`.
 * Derived from the client method's signature so it stays in lock-step with the
 * core without re-declaring the (unexported) option shape.
 */
export type MutationCallOptions = NonNullable<Parameters<CirrusClient["mutation"]>[2]>;

/** Handle returned by {@link mutation}: an awaitable `mutate` plus a live `pending` store. */
export interface MutationHandle<F extends FunctionReference> {
    /**
     * Run the mutation. Resolves with the server result and rejects on failure
     * (errors propagate — there is no swallowing). Optimistic updates passed in
     * `options` are applied and rolled back by the client against the live query
     * subscriptions, exactly as in the React adapter.
     */
    mutate: (args: ArgsOf<F>, options?: MutationCallOptions) => Promise<ReturnOf<F>>;

    /**
     * `true` while any invocation from this handle is in flight. Ref-counted, so
     * overlapping calls compose and it only flips back to `false` once the last
     * one settles. Read it with `$pending` in a component to disable a button.
     */
    pending: Readable<boolean>;
}

/**
 * Create an optimistic {@link MutationHandle} for a mutation reference. The
 * Svelte counterpart to React's `useMutation`: returns `{ mutate, pending }`
 * where `mutate` is an awaitable and `pending` is a readable store.
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

    // Ref-counted pending: `inFlight` tracks overlapping calls so `pending` only
    // clears once the last one settles (matching the React hook's semantics).
    let inFlight = 0;
    const pending = writable(false);

    const mutate = async (args: ArgsOf<F>, options?: MutationCallOptions): Promise<ReturnOf<F>> => {
        inFlight += 1;
        pending.set(true);

        try {
            return await client.mutation<F>(functionRef, args, options);
        } finally {
            inFlight -= 1;
            pending.set(inFlight > 0);
        }
    };

    return { mutate, pending };
}
