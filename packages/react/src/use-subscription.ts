"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { createQuerySubscription } from "@cirrus/client/query";
import { useEffect, useRef, useState } from "react";

import { useCirrus } from "./cirrus-provider";
import { stableStringify } from "./query-key";
import type { UseQueryOptions, UseSubscriptionResult } from "./types";

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

        // The subscribe → snapshot → error → cleanup lifecycle lives in the shared
        // `@cirrus/client/query` state machine; this hook only binds it to React
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
                    const normalized = new Error(error.message);

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
    }, [client, function_.__cirrusRef, serialized, options.shardKey, skipped]);

    return state;
};

export default useSubscription;
