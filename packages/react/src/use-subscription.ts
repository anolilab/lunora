import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useEffect, useRef, useState } from "react";

import { useCirrus } from "./cirrus-provider.js";
import type { UseQueryOptions, UseSubscriptionResult } from "./types.js";

/**
 * JSON.stringify with deterministic key ordering for plain objects. Keeps
 * the subscription cache key stable across rerenders where the consumer
 * happens to construct `args` with a different key order.
 */
const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b));

    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
};

/**
 * Subscribe to a real-time stream from the server. Unlike `useQuery`, this
 * hook does not issue an initial HTTP fetch — it only delivers values that
 * the server pushes over the WS.
 */
export function useSubscription<F extends FunctionReference>(
    fn: F,
    args: ArgsOf<F> | "skip",
    options: UseQueryOptions = {},
): UseSubscriptionResult<ReturnOf<F>> {
    const client = useCirrus();
    const [state, setState] = useState<UseSubscriptionResult<ReturnOf<F>>>({ data: undefined, error: undefined });

    const skipped = args === "skip";
    const serialized = skipped ? "skip" : stableStringify(args);

    // Latest subscribe inputs. The dependency array keys off `fn.__cirrusRef`
    // and the serialized args, which already capture every meaningful change;
    // reading `fn`/`args` from a ref keeps the dependency array honest without
    // re-subscribing whenever the consumer recreates them with the same value.
    const subscribeRef = useRef({ args, fn });

    subscribeRef.current = { args, fn };

    useEffect(() => {
        if (skipped) {
            return;
        }

        let cancelled = false;
        const { args: currentArgs, fn: currentFn } = subscribeRef.current;

        try {
            const unsubscribe = client.subscribe(
                currentFn,
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
    }, [client, fn.__cirrusRef, serialized, options.shardKey, skipped]);

    return state;
}
