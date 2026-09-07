"use client";

import type { HttpStreamArgsOf, HttpStreamChunkOf, HttpStreamRef } from "@lunora/client";
import { useEffect, useReducer, useRef } from "react";

import { useLunora } from "./lunora-provider";
import { stableWireKey } from "./query-key";
import type { StreamAction, StreamState, UseStreamStatus } from "./stream-state";
import { consumeStream, streamReducer } from "./stream-state";

/**
 * Result shape returned by {@link useHttpStream}.
 * @experimental Part of the HTTP-SSE stream surface.
 */
interface UseHttpStreamResult<T> {
    /** Force-cancel the stream (aborts the fetch) and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** Chunks the server has pushed so far, in arrival order. */
    chunks: ReadonlyArray<T>;
    error: Error | undefined;
    status: UseStreamStatus;
}

/**
 * Options accepted by {@link useHttpStream}.
 * @experimental Part of the HTTP-SSE stream surface.
 */
interface UseHttpStreamOptions {
    /** Forwarded to `client.httpStream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;
}

/**
 * Consume an **HTTP-SSE route stream** (`httpRoute.<verb>(path).stream()`) via
 * `client.httpStream`. Distinct from `useStream`, which consumes the WS
 * procedure stream (`kind: "stream"`). Returns the chunks received so far plus
 * a lifecycle status and a cancel function. Changing the route or the
 * serialized `args` resets the stream — the previous fetch is aborted (the
 * server sees `request.signal`) and a fresh one opens with empty `chunks`.
 * Unmount also aborts.
 *
 * Pass `"skip"` for `args` to keep the hook mounted without opening a stream
 * (mirrors `useQuery` / `useStream`).
 * @experimental Reconnect/POST-body/wire-fidelity design questions are still open, so the shape may change.
 */
const useHttpStream = <Ref extends HttpStreamRef>(
    route: Ref,
    args: "skip" | HttpStreamArgsOf<Ref>,
    options: UseHttpStreamOptions = {},
): UseHttpStreamResult<HttpStreamChunkOf<Ref>> => {
    type Chunk = HttpStreamChunkOf<Ref>;

    const client = useLunora();
    const [state, dispatch] = useReducer<StreamState<Chunk>, [StreamAction<Chunk>]>(streamReducer<Chunk>, { chunks: [], error: undefined, status: "idle" });

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
            // its last status over stale chunks, mirroring useStream's skip
            // teardown.
            dispatch({ type: "reset" });

            return () => {};
        }

        dispatch({ type: "reset" });
        dispatch({ type: "start" });

        const { cancel, cleanup } = consumeStream(client.httpStream(route, args, { maxBuffer: options.maxBuffer }), dispatch);

        cancelRef.current = cancel;

        return () => {
            cleanup();
            cancelRef.current = undefined;
        };
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the stream re-opens on the route's stable `method`/`path` and the serialized args (a content hash) rather than the raw `route`/`args` object identity, so a caller recreating them with the same value doesn't tear down and re-open the stream. `client` is provider-stable.
    }, [client, route.method, route.path, serialized, skipped, options.maxBuffer]);

    return {
        cancel: () => {
            cancelRef.current?.();
        },
        chunks: state.chunks,
        error: state.error,
        status: state.status,
    };
};

export type { UseHttpStreamOptions, UseHttpStreamResult };
export { useHttpStream };
