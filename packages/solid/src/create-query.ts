import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import type { Accessor } from "solid-js";
import { createEffect, createSignal, on, onCleanup } from "solid-js";

import { useLunora } from "./context";

export interface CreateQueryOptions {
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
 * (via `onCleanup`) and a fresh one opens for the new args. Pass `"skip"` (or an
 * accessor returning `"skip"`) to short-circuit: no network call, no socket.
 *
 * ```tsx
 * const messages = createQuery(api.messages.list, () => ({ channelId: channelId() }));
 * return <For each={messages()?.messages}>{(m) => <li>{m.text}</li>}</For>;
 * ```
 */
export const createQuery = <F extends FunctionReference>(
    function_: F,
    args: (ArgsOf<F> | "skip") | Accessor<ArgsOf<F> | "skip">,
    options: CreateQueryOptions = {},
): Accessor<ReturnOf<F> | undefined> => {
    const client = useLunora();
    const { shardKey } = options;

    const [value, setValue] = createSignal<ReturnOf<F> | undefined>(undefined);

    const resolveArgs = (): ArgsOf<F> | "skip" => (typeof args === "function" ? (args as Accessor<ArgsOf<F> | "skip">)() : args);

    // `on(resolveArgs, …)` re-runs the body whenever the args accessor changes,
    // tearing down the previous subscription via `onCleanup` before opening the
    // next. A static (non-accessor) `args` resolves once and never re-runs. The
    // skip-handling, subscribe, and cleanup are owned by the shared
    // `@lunora/client/query` state machine; this binds it to a Solid signal. The
    // `() => …` setter forms keep Solid from mistaking a function-valued server
    // result for an updater.
    createEffect(
        on(resolveArgs, (current) => {
            const unsubscribe = createQuerySubscription<F>(
                client,
                function_,
                current,
                {
                    onData: (next) => {
                        setValue(() => next);
                    },
                    onReset: () => {
                        setValue(() => undefined as ReturnOf<F> | undefined);
                    },
                },
                { shardKey },
            );

            onCleanup(unsubscribe);
        }),
    );

    return value;
};
