"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import { LunoraError } from "@lunora/errors";
import { useEffect, useRef, useState } from "react";

import { useLunora } from "./lunora-provider";
import { stableWireKey } from "./query-key";
import type { UseQueryOptions, UseSubscriptionResult } from "./types";

/**
 * Subscribe to a real-time stream from the server. Unlike `useQuery`, this
 * hook does not issue an initial HTTP fetch — it only delivers values that
 * the server pushes over the WS.
 *
 * A server-pushed error lands on `error` as a `LunoraError` carrying the
 * server's `code` (a bare `Error` only when the server sent no code), so
 * consumers can branch on the error kind; `onError` receives the raw
 * `SubscriptionError` in addition.
 */
const useSubscription = <F extends FunctionReference>(
    function_: F,
    args: ArgsOf<F> | "skip",
    options: UseQueryOptions = {},
): UseSubscriptionResult<ReturnOf<F>> => {
    const client = useLunora();
    const [state, setState] = useState<UseSubscriptionResult<ReturnOf<F>>>({ data: undefined, error: undefined });

    const skipped = args === "skip";
    const serialized = skipped ? "skip" : stableWireKey(args);

    // The subscribe effect keys off the serialized args, so an inline `onError`
    // must not change its identity — read the latest handler through a ref.
    const onErrorRef = useRef(options.onError);

    useEffect(() => {
        onErrorRef.current = options.onError;
    });

    // Latest subscribe inputs. The dependency array keys off `fn.__lunoraRef`
    // and the serialized args, which already capture every meaningful change;
    // reading `fn`/`args` from a ref keeps the dependency array honest without
    // re-subscribing whenever the consumer recreates them with the same value.
    // The ref is refreshed in an effect (not during render) so it stays a legal
    // write — the subscribe effect below reads `.current` at run time.
    const subscribeRef = useRef({ args, fn: function_ });

    useEffect(() => {
        subscribeRef.current = { args, fn: function_ };
    });

    // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- intentional: the several `setState` calls here fire in mutually-exclusive branches/callbacks (skip reset, onData, deferred onError) across the subscription lifecycle, not as a synchronous cascade within one render.
    useEffect(() => {
        if (skipped) {
            // Args transitioned to "skip" — tear down any prior subscription
            // (handled by the previous effect's cleanup) and clear stale data so
            // the UI reflects "no subscription, no data", matching Solid/Vue.
            // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-hooks-js/set-state-in-effect -- intentional: clearing data when `args` becomes "skip" is a deliberate teardown that matches the Solid/Vue adapters; there is no prior value to derive from (the subscription is gone), so this cannot be lifted to render-phase derived state.
            setState({ data: undefined, error: undefined });

            return () => {};
        }

        let cancelled = false;
        const { args: currentArgs, fn: currentFunction } = subscribeRef.current;

        // The subscribe → snapshot → error → cleanup lifecycle lives in the shared
        // `@lunora/client/query` state machine; this hook only binds it to React
        // state. The error sink maps the client's `SubscriptionError` back to an
        // `Error` (the public `UseSubscriptionResult` shape) and is deferred out
        // of the synchronous effect body so it isn't a state adjustment made
        // directly in response to a prop change.
        const unsubscribe = createQuerySubscription(
            client,
            currentFunction,
            currentArgs as ArgsOf<F>,
            {
                onData: (value: ReturnOf<F>) => {
                    if (cancelled) {
                        return;
                    }

                    setState({ data: value, error: undefined });
                },
                onError: (error) => {
                    // Preserve the server-supplied `code` (matching Vue/Svelte's
                    // subscription primitives) so consumers can branch on the
                    // error kind instead of only seeing a flat message.
                    const normalized = error.code === undefined ? new Error(error.message) : new LunoraError(error.code, error.message);

                    onErrorRef.current?.(error);

                    queueMicrotask(() => {
                        if (!cancelled) {
                            setState({ data: undefined, error: normalized });
                        }
                    });
                },
            },
            { shardKey: options.shardKey },
        );

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [client, function_.__lunoraRef, serialized, options.shardKey, skipped]);

    return state;
};

export default useSubscription;
