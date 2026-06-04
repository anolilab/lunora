"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useEffect, useRef, useState } from "react";

import { useCirrus } from "./cirrus-provider.js";
import { stableStringify } from "./query-key.js";
import type { UseQueryOptions, UseSubscriptionResult } from "./types.js";

/**
 * Subscribe to a real-time stream from the server. Unlike `useQuery`, this
 * hook does not issue an initial HTTP fetch — it only delivers values that
 * the server pushes over the WS.
 */
const useSubscription = <F extends FunctionReference>(
    function_: F,
    args: ArgsOf<F> | "skip",
    options: UseQueryOptions = {},
): UseSubscriptionResult<ReturnOf<F>> => {
    const client = useCirrus();
    const [state, setState] = useState<UseSubscriptionResult<ReturnOf<F>>>({ data: undefined, error: undefined });

    const skipped = args === "skip";
    const serialized = skipped ? "skip" : stableStringify(args);

    // Latest subscribe inputs. The dependency array keys off `fn.__cirrusRef`
    // and the serialized args, which already capture every meaningful change;
    // reading `fn`/`args` from a ref keeps the dependency array honest without
    // re-subscribing whenever the consumer recreates them with the same value.
    // The ref is refreshed in an effect (not during render) so it stays a legal
    // write — the subscribe effect below reads `.current` at run time.
    const subscribeRef = useRef({ args, fn: function_ });

    useEffect(() => {
        subscribeRef.current = { args, fn: function_ };
    });

    useEffect(() => {
        if (skipped) {
            return undefined;
        }

        let cancelled = false;
        const { args: currentArgs, fn: currentFunction } = subscribeRef.current;

        try {
            const unsubscribe = client.subscribe(
                currentFunction,
                currentArgs as ArgsOf<F>,
                (value) => {
                    if (cancelled) {
                        return;
                    }

                    setState({ data: value, error: undefined });
                },
                { shardKey: options.shardKey },
            );

            return () => {
                cancelled = true;
                unsubscribe();
            };
        } catch (error: unknown) {
            const normalized = error instanceof Error ? error : new Error(String(error));

            // Defer out of the synchronous effect body so the error isn't a
            // state adjustment made directly in response to a prop change.
            queueMicrotask(() => {
                if (!cancelled) {
                    setState({ data: undefined, error: normalized });
                }
            });

            return () => {
                cancelled = true;
            };
        }
    }, [client, function_.__cirrusRef, serialized, options.shardKey, skipped]);

    return state;
};

export default useSubscription;
