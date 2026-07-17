"use client";

import type { HttpStreamArgsOf, HttpStreamChunkOf, HttpStreamRef } from "@lunora/client";
import { useEffect, useReducer, useRef } from "react";

import { useLunora } from "./lunora-provider";
import { stableStringify } from "./query-key";
import type { UseStreamStatus } from "./use-stream";

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

interface State<T> {
    chunks: T[];
    error: Error | undefined;
    status: UseStreamStatus;
}

type Action<T> = { chunk: T; type: "chunk" } | { type: "complete" } | { error: Error; type: "error" } | { type: "reset" } | { type: "start" };

// Mirrors `use-stream.ts`'s reducer — the two hooks share their lifecycle
// shape but stay separate files so each stream primitive evolves on its own.
const reducer = function <T>(state: State<T>, action: Action<T>): State<T> {
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

/**
 * Consume an **HTTP-SSE route stream** (`httpRoute.&lt;verb>(path).stream()`) via
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
    const [state, dispatch] = useReducer<State<Chunk>, [Action<Chunk>]>(reducer<Chunk>, { chunks: [], error: undefined, status: "idle" });

    const skipped = args === "skip";
    const serialized = skipped ? "skip" : stableStringify(args);

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

        let stillMounted = true;
        let cancelled = false;
        const iterable = client.httpStream(route, args, { maxBuffer: options.maxBuffer });
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
        // IIFE owns its own try/catch so any error already lands in the reducer;
        // the trailing `.catch` is a belt-and-braces guard that can never fire.
        (async () => {
            try {
                // react-doctor-disable-next-line react-hooks-js/todo -- `for await` over the stream iterable is the effect's core consumer loop; it lives inside a background IIFE (not render), and the compiler simply can't lower `for-await` yet. The construct is required, not optimizable-away.
                for await (const chunk of iterable) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stillMounted` is flipped to `false` by the cleanup closure between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                    if (!stillMounted) {
                        return;
                    }

                    dispatch({ chunk, type: "chunk" });
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stillMounted` may have been flipped to `false` by the cleanup closure while the iterator was awaiting; the guard is real, not dead.
                if (stillMounted) {
                    dispatch({ type: "complete" });
                }
            } catch (error: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stillMounted` may have been flipped to `false` by the cleanup closure while the iterator was awaiting; the guard is real, not dead.
                if (!stillMounted) {
                    return;
                }

                const normalized = error instanceof Error ? error : new Error(String(error));

                dispatch({ error: normalized, type: "error" });
            }
        })().catch(() => {
            // Unreachable: the IIFE's own try/catch already routes errors into
            // the reducer. This satisfies no-floating-promises.
        });

        return () => {
            stillMounted = false;
            cancel();
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
