import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionErrorCallback } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import { LunoraError } from "@lunora/errors";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";
import { trackedEffect } from "./solid-compat";

interface CreateSubscriptionResult<T> {
    data: Accessor<T | undefined>;
    error: Accessor<Error | undefined>;
}

/**
 * Subscribe to a reactive server push stream. Returns `{ data, error }`
 * accessors that update whenever the server emits. Passing `"skip"` as `args`
 * (or an accessor that resolves to `"skip"`) tears down the subscription.
 *
 * `onError` mirrors the other adapters' subscription primitives: it receives the
 * raw wire-level subscription error (code included) alongside the normalised
 * `error` accessor.
 */
const createSubscription = <F extends FunctionReference>(
    function_: F,
    args: ArgsOf<F> | "skip" | Accessor<ArgsOf<F> | "skip">,
    options: { onError?: SubscriptionErrorCallback; shardKey?: string } = {},
): CreateSubscriptionResult<ReturnOf<F>> => {
    const client = useLunora();

    const [data, setData] = createSignal<ReturnOf<F> | undefined>(undefined);
    const [error, setError] = createSignal<Error | undefined>(undefined);

    const resolveArgs = typeof args === "function" ? (args as Accessor<ArgsOf<F> | "skip">) : () => args;

    trackedEffect(resolveArgs, (currentArgs) => {
        // Each args generation starts clean: the previous args' value must not
        // render under the new args until the new subscription's first frame.
        setData(() => undefined);
        setError(() => undefined);

        if (currentArgs === "skip") {
            return undefined;
        }

        return createQuerySubscription(
            client,
            function_,
            currentArgs,
            {
                onData: (value: ReturnOf<F>) => {
                    setData(() => value);
                    setError(() => undefined);
                },
                onError: (subscriptionError) => {
                    // Preserve the wire-level `code` the server attached (e.g.
                    // "auth-expired" vs "not-found") so callers can branch on it —
                    // a plain `new Error(message)` would discard it. When a code is
                    // present, surface a `LunoraError` (its `.code` is typed);
                    // otherwise fall back to a bare `Error`.
                    const normalized = subscriptionError.code
                        ? new LunoraError(subscriptionError.code, subscriptionError.message)
                        : new Error(subscriptionError.message);

                    setError(() => normalized);
                    setData(() => undefined);
                    options.onError?.(subscriptionError);
                },
                onReset: () => {
                    setData(() => undefined);
                },
            },
            { shardKey: options.shardKey },
        );
    });

    return { data, error };
};

export type { CreateSubscriptionResult };
export { createSubscription };
