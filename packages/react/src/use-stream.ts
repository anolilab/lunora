import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useEffect, useReducer, useRef } from "react";

import { useCirrus } from "./cirrus-provider.js";

/** The lifecycle of a stream the hook is observing. */
export type UseStreamStatus = "complete" | "error" | "idle" | "streaming";

export interface UseStreamResult<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** Chunks the server has pushed so far, in arrival order. */
    chunks: ReadonlyArray<T>;
    error: Error | undefined;
    status: UseStreamStatus;
}

export interface UseStreamOptions {
    /** Forwarded to `client.stream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;
    shardKey?: string;
}

interface State<T> {
    chunks: T[];
    error: Error | undefined;
    status: UseStreamStatus;
}

type Action<T> = { chunk: T; type: "chunk" } | { type: "complete" } | { error: Error; type: "error" } | { type: "reset" } | { type: "start" };

const reducer = <T>(state: State<T>, action: Action<T>): State<T> => {
    switch (action.type) {
        case "chunk": {
            // Append immutably so consumers comparing by identity see a change.
            return { chunks: [...state.chunks, action.chunk], error: undefined, status: "streaming" };
        }
        case "complete": {
            return { ...state, status: "complete" };
        }
        case "error": {
            return { ...state, error: action.error, status: "error" };
        }
        case "reset": {
            return { chunks: [], error: undefined, status: "idle" };
        }
        case "start": {
            // Distinct from `chunk` so the UI can render "loading" before the
            // first frame arrives without conflating it with the idle state.
            return { ...state, status: "streaming" };
        }
        default: {
            return state;
        }
    }
};

const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));

    return `{${entries.map(([key, value_]) => `${JSON.stringify(key)}:${stableStringify(value_)}`).join(",")}}`;
};

/**
 * Subscribe to a streaming query. Returns the chunks pushed so far plus a
 * lifecycle status and a cancel function. Changing `fn` or the serialized
 * `args` resets the stream — the previous iterator is cancelled and a fresh
 * one opens with empty `chunks`.
 *
 * Pass `"skip"` for `args` to keep the hook mounted without opening a stream
 * (mirrors `useQuery` / `useSubscription`).
 */
export function useStream<F extends FunctionReference>(fn: F, args: "skip" | ArgsOf<F>, options: UseStreamOptions = {}): UseStreamResult<ReturnOf<F>> {
    const client = useCirrus();
    const [state, dispatch] = useReducer<State<ReturnOf<F>>, [Action<ReturnOf<F>>]>(reducer<ReturnOf<F>>, { chunks: [], error: undefined, status: "idle" });

    const skipped = args === "skip";
    const serialized = skipped ? "skip" : stableStringify(args);

    // Stash the live cancel handle so unmount + manual cancel call into the
    // same function. The reducer doesn't own it because cancel is a side
    // effect, not part of the rendered state.
    const cancelRef = useRef<(() => void) | undefined>(undefined);

    useEffect(() => {
        if (skipped) {
            return;
        }

        dispatch({ type: "reset" });
        dispatch({ type: "start" });

        let stillMounted = true;
        let cancelled = false;
        const iterable = client.stream(fn, args as ArgsOf<F>, { maxBuffer: options.maxBuffer, shardKey: options.shardKey });
        const cancel = (): void => {
            if (cancelled) {
                return;
            }

            cancelled = true;
            iterable.cancel();
        };

        cancelRef.current = cancel;

        // Run the consumer loop in a background async IIFE so the effect body
        // stays synchronous; the cancel handle is what the cleanup uses. The
        // `void` mark tells the linter we intentionally don't await — the IIFE
        // owns its own try/catch so any error already lands in the reducer.
        void (async () => {
            try {
                for await (const chunk of iterable) {
                    if (!stillMounted) {
                        return;
                    }

                    dispatch({ type: "chunk", chunk: chunk as ReturnOf<F> });
                }

                if (stillMounted) {
                    dispatch({ type: "complete" });
                }
            } catch (error: unknown) {
                if (!stillMounted) {
                    return;
                }

                const normalized = error instanceof Error ? error : new Error(String(error));

                dispatch({ type: "error", error: normalized });
            }
        })();

        return () => {
            stillMounted = false;
            cancel();
            cancelRef.current = undefined;
        };
    }, [client, fn.__cirrusRef, serialized, skipped, options.shardKey, options.maxBuffer]);

    return {
        cancel: () => {
            cancelRef.current?.();
        },
        chunks: state.chunks,
        error: state.error,
        status: state.status,
    };
}
