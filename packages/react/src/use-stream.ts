"use client";

import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { useEffect, useReducer, useRef } from "react";

import { useLunora } from "./lunora-provider";
import { stableWireKey } from "./query-key";
import type { StreamAction, StreamState, UseStreamStatus } from "./stream-state";
import { consumeStream, streamReducer } from "./stream-state";

interface UseStreamResult<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** Chunks the server has pushed so far, in arrival order. */
    chunks: ReadonlyArray<T>;
    error: Error | undefined;
    status: UseStreamStatus;
}

interface UseStreamOptions {
    /** Forwarded to `client.stream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;
    shardKey?: string;
}

/**
 * Subscribe to a streaming query. Returns the chunks pushed so far plus a
 * lifecycle status and a cancel function. Changing `fn` or the serialized
 * `args` resets the stream — the previous iterator is cancelled and a fresh
 * one opens with empty `chunks`.
 *
 * Pass `"skip"` for `args` to keep the hook mounted without opening a stream
 * (mirrors `useQuery` / `useSubscription`).
 */
const useStream = <F extends FunctionReference<"stream">>(
    function_: F,
    args: "skip" | ArgsOf<F>,
    options: UseStreamOptions = {},
): UseStreamResult<ReturnOf<F>> => {
    const client = useLunora();
    const [state, dispatch] = useReducer<StreamState<ReturnOf<F>>, [StreamAction<ReturnOf<F>>]>(streamReducer<ReturnOf<F>>, {
        chunks: [],
        error: undefined,
        status: "idle",
    });

    const skipped = args === "skip";
    const serialized = skipped ? "skip" : stableWireKey(args);

    // Stash the live cancel handle so unmount + manual cancel call into the
    // same function. The reducer doesn't own it because cancel is a side
    // effect, not part of the rendered state.
    const cancelRef = useRef<(() => void) | undefined>(undefined);

    useEffect(() => {
        if (skipped) {
            // Args transitioned to "skip" — the previous effect's cleanup already
            // cancelled the iterator, so no `complete`/`error` will ever fire.
            // Reset to idle with empty chunks so the hook doesn't stay stuck in
            // its last status over stale chunks, mirroring useSubscription's skip
            // teardown.
            dispatch({ type: "reset" });

            return () => {};
        }

        dispatch({ type: "reset" });
        dispatch({ type: "start" });

        const { cancel, cleanup } = consumeStream(client.stream(function_, args, { maxBuffer: options.maxBuffer, shardKey: options.shardKey }), dispatch);

        cancelRef.current = cancel;

        return () => {
            cleanup();
            cancelRef.current = undefined;
        };
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the stream re-opens on the query's stable `__lunoraRef` and the serialized args (a content hash) rather than the raw `function_`/`args` object identity, so a caller recreating them with the same value doesn't tear down and re-open the stream. `client` is provider-stable.
    }, [client, function_.__lunoraRef, serialized, skipped, options.shardKey, options.maxBuffer]);

    return {
        cancel: () => {
            cancelRef.current?.();
        },
        chunks: state.chunks,
        error: state.error,
        status: state.status,
    };
};

export type { UseStreamOptions, UseStreamResult };
export { useStream };

export { type UseStreamStatus } from "./stream-state";
