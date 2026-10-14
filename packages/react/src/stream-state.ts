import type { StreamIterable } from "@lunora/client";

/** The lifecycle of a stream the hook is observing. */
type UseStreamStatus = "complete" | "error" | "idle" | "streaming";

interface StreamState<T> {
    chunks: T[];
    error: Error | undefined;
    status: UseStreamStatus;
}

type StreamAction<T> = { chunk: T; type: "chunk" } | { type: "complete" } | { error: Error; type: "error" } | { type: "reset" } | { type: "start" };

/** Shared lifecycle reducer for `useStream` (WS procedure streams) and `useHttpStream` (HTTP-SSE route streams). */
const streamReducer = function <T>(state: StreamState<T>, action: StreamAction<T>): StreamState<T> {
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
 * Drive one stream's consumer loop: pump `iterable` into `dispatch` until it
 * completes, errors, or is cancelled. The loop runs in a background async IIFE
 * so the calling effect body stays synchronous. Returns the idempotent `cancel`
 * handle plus the effect `cleanup` (which also stops dispatching).
 */
const consumeStream = function <T>(iterable: StreamIterable<T>, dispatch: (action: StreamAction<T>) => void): { cancel: () => void; cleanup: () => void } {
    let stillMounted = true;
    let cancelled = false;

    const cancel = (): void => {
        if (cancelled) {
            return;
        }

        cancelled = true;
        iterable.cancel();
    };

    // The IIFE owns its own try/catch so any error already lands in the
    // reducer; the trailing `.catch` is a belt-and-braces guard that can never
    // fire.
    (async () => {
        try {
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

            dispatch({ error: error instanceof Error ? error : new Error(String(error)), type: "error" });
        }
    })().catch(() => {
        // Unreachable: the loop's own try/catch already routes errors into the
        // reducer. This satisfies no-floating-promises.
    });

    return {
        cancel,
        cleanup: (): void => {
            stillMounted = false;
            cancel();
        },
    };
};

export type { StreamAction, StreamState, UseStreamStatus };
export { consumeStream, streamReducer };
