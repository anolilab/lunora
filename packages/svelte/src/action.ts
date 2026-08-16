import type { ActionCallOptions, ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import { createActionRunner } from "@lunora/client";
import type { Readable } from "svelte/store";
import { writable } from "svelte/store";

import { getLunoraClient } from "./context";

/**
 * The reactive handle returned by {@link action} — the Svelte counterpart to
 * React's `useAction`, re-expressed as stores you read with `$`. The surface is
 * identical across the Lunora adapters (`@lunora/solid`, `/vue`).
 */
export interface ActionHandle<F extends FunctionReference> {
    /**
     * Run the action. Resolves with the server result and rejects on failure
     * (errors propagate — there is no swallowing).
     */
    call: (args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Readable<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Readable<Error | undefined>;

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
 * Create an {@link ActionHandle} for an action reference. The Svelte
 * counterpart to React's `useAction`: returns `{ data, error, pending, call,
 * reset }` of readable stores plus an awaitable `call`.
 *
 * **Narrower than `mutation` on purpose:** no `optimistic` /
 * `optimisticUpdate`. An optimistic update patches the subscription cache on the
 * assumption a write will land; an action is not a write — it runs in the
 * Worker, may call a third party, and has no declared effect on any query.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient`.
 */
export function action<F extends FunctionReference>(function_: F): ActionHandle<F>;
export function action<F extends FunctionReference>(client: LunoraClient, function_: F): ActionHandle<F>;
export function action<F extends FunctionReference>(clientOrFunction: LunoraClient | F, maybeFunction?: F): ActionHandle<F> {
    const hasExplicitClient = maybeFunction !== undefined;
    const client = hasExplicitClient ? (clientOrFunction as LunoraClient) : getLunoraClient();
    const functionRef = (hasExplicitClient ? maybeFunction : clientOrFunction) as F;

    const data = writable<ReturnOf<F> | undefined>();
    const error = writable<Error | undefined>();
    const pending = writable(false);

    const call = createActionRunner<F>(client, functionRef, {
        setError: (next) => {
            error.set(next);
        },
        setPending: (next) => {
            pending.set(next);
        },
        setResult: (result) => {
            data.set(result);
            error.set(undefined);
        },
    });

    const reset = (): void => {
        data.set(undefined);
        error.set(undefined);
    };

    return { call, data, error, pending, reset };
}
