import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionErrorCallback } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";
import { trackedEffect } from "./solid-compat";

export interface CreateQueryOptions {
    /**
     * Called when the server pushes a subscription-scoped error (an RLS denial, a
     * query that starts failing server-side). Without a handler such an error has
     * nowhere to go and the accessor simply freezes at its last good value.
     */
    onError?: SubscriptionErrorCallback;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * Subscribe to a server query and return a reactive accessor of its value.
 *
 * The accessor reads `undefined` until the first server frame lands, then
 * updates on every delta the WebSocket pushes — Solid's fine-grained signals
 * mean only the components that read the accessor re-render, which maps cleanly
 * onto Lunora's per-subscription delta model.
 *
 * `args` may be a plain value or an accessor; passing an accessor makes the
 * subscription reactive — when the args change the old subscription is torn down
 * (via `onCleanup`), the accessor resets to `undefined`, and a fresh one opens for
 * the new args. Pass `"skip"` (or an
 * accessor returning `"skip"`) to short-circuit: no network call, no socket.
 *
 * ```tsx
 * const messages = createQuery(api.messages.list, () => ({ channelId: channelId() }));
 * return <For each={messages()?.messages}>{(m) => <li>{m.text}</li>}</For>;
 * ```
 *
 * Pass `onError` to surface a subscription-scoped error the server pushes (an RLS
 * denial, a query that starts failing server-side). Without it such an error is
 * dropped and the accessor just freezes at its last good value.
 */
export const createQuery = <F extends FunctionReference>(
    function_: F,
    args: (ArgsOf<F> | "skip") | Accessor<ArgsOf<F> | "skip">,
    options: CreateQueryOptions = {},
): Accessor<ReturnOf<F> | undefined> => {
    const client = useLunora();
    const { onError, shardKey } = options;

    const [value, setValue] = createSignal<ReturnOf<F> | undefined>(undefined);

    const resolveArgs = (): ArgsOf<F> | "skip" => (typeof args === "function" ? (args as Accessor<ArgsOf<F> | "skip">)() : args);

    // `trackedEffect(resolveArgs, …)` re-runs the body whenever the args
    // accessor changes, tearing down the previous subscription (the returned
    // disposer) before opening the next. A static (non-accessor) `args` resolves
    // once and never re-runs. The skip-handling, subscribe, and cleanup are
    // owned by the shared `@lunora/client/query` state machine; this binds it to
    // a Solid signal. The `() => …` setter forms keep Solid from mistaking a
    // function-valued server result for an updater.
    trackedEffect(resolveArgs, (current) => {
        // The previous args' value must not render under the new args until the
        // new subscription's first frame lands.
        setValue(() => undefined as ReturnOf<F> | undefined);

        const unsubscribe = createQuerySubscription<F>(
            client,
            function_,
            current,
            {
                onData: (next) => {
                    setValue(() => next);
                },
                onError,
                onReset: () => {
                    setValue(() => undefined as ReturnOf<F> | undefined);
                },
            },
            { shardKey },
        );

        return unsubscribe;
    });

    return value;
};
