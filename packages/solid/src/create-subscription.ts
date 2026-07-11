import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import { LunoraError } from "@lunora/errors";
import type { Accessor } from "solid-js";
import { createEffect, createSignal, on, onCleanup } from "solid-js";

import { useLunora } from "./context";

interface CreateSubscriptionResult<T> {
    data: Accessor<T | undefined>;
    error: Accessor<Error | undefined>;
}

/**
 * Subscribe to a reactive server push stream. Returns `{ data, error }`
 * accessors that update whenever the server emits. Passing `"skip"` as `args`
 * (or an accessor that resolves to `"skip"`) tears down the subscription.
 */
const createSubscription = <F extends FunctionReference>(
    function_: F,
    args: ArgsOf<F> | "skip" | Accessor<ArgsOf<F> | "skip">,
    options: { shardKey?: string } = {},
): CreateSubscriptionResult<ReturnOf<F>> => {
    const client = useLunora();

    const [data, setData] = createSignal<ReturnOf<F> | undefined>(undefined);
    const [error, setError] = createSignal<Error | undefined>(undefined);

    const resolveArgs = typeof args === "function" ? (args as Accessor<ArgsOf<F> | "skip">) : () => args;

    createEffect(
        on(resolveArgs, (currentArgs) => {
            if (currentArgs === "skip") {
                setData(() => undefined);
                setError(() => undefined);
                return;
            }

            const unsubscribe = createQuerySubscription(
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
                    },
                    onReset: () => {
                        setData(() => undefined);
                    },
                },
                { shardKey: options.shardKey },
            );

            onCleanup(unsubscribe);
        }),
    );

    return { data, error };
};

export type { CreateSubscriptionResult };
export { createSubscription };
