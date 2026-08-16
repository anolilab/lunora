import type { ActionCallOptions, ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createActionRunner } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";

export interface ActionHandle<F extends FunctionReference> {
    /** Invoke the action. Resolves with the server result; rejects on failure. */
    call: (args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
    /** The latest invocation's resolved value, or `undefined` before the first success. */
    data: Accessor<ReturnOf<F> | undefined>;
    /** The latest invocation's error, or `undefined`. */
    error: Accessor<Error | undefined>;
    /** `true` while any invocation from this handle is in flight (ref-counted, so overlapping calls compose). */
    pending: Accessor<boolean>;
    /** Clear `data`/`error` back to idle. */
    reset: () => void;
}

/**
 * The transport surface {@link createAction} actually needs — just
 * `client.action`. Narrowed so the primitive can be exercised against a stub in
 * tests without constructing a full `LunoraClient`.
 */
export interface ActionClient<F extends FunctionReference> {
    action: (function_: F, args: ArgsOf<F>, options?: ActionCallOptions) => Promise<ReturnOf<F>>;
}

/**
 * Build an action handle bound to an explicit client. Internal seam used by the
 * provider-bound {@link createAction}; exported for tests that inject a stub.
 * The ref-counted pending + error-normalize orchestration is the shared
 * `createActionRunner` from `@lunora/client`; only the reactive sinks (Solid
 * signals) are adapter-specific.
 */
export const createActionForClient = <F extends FunctionReference>(client: ActionClient<F>, function_: F): ActionHandle<F> => {
    const [data, setData] = createSignal<ReturnOf<F> | undefined>(undefined);
    const [error, setError] = createSignal<Error | undefined>(undefined);
    const [pending, setPending] = createSignal(false);

    const call = createActionRunner(client, function_, {
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

    return { call, data, error, pending, reset };
};

/**
 * Returns a reactive handle `{ call, pending, data, error, reset }` for the
 * given action reference, bound to the `LunoraClient` from the nearest
 * `<LunoraProvider>`.
 *
 * **Narrower than `createMutation` on purpose:** no `optimistic` /
 * `optimisticUpdate` call options. An optimistic update patches the subscription
 * cache on the assumption a write will land; an action is not a write — it runs
 * in the Worker, may call a third party, and has no declared effect on any
 * query. Offering the option would imply a rollback guarantee nothing can
 * honour.
 */
export const createAction = <F extends FunctionReference>(function_: F): ActionHandle<F> => createActionForClient(useLunora(), function_);
