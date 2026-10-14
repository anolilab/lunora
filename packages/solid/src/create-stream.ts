import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal, onCleanup } from "solid-js";

import { useLunora } from "./context";
import { trackedEffect } from "./solid-compat";

/** The lifecycle of a stream the primitive is observing. */
type CreateStreamStatus = "complete" | "error" | "idle" | "streaming";

interface CreateStreamResult<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** Chunks the server has pushed so far, in arrival order. */
    chunks: Accessor<ReadonlyArray<T>>;
    error: Accessor<Error | undefined>;
    status: Accessor<CreateStreamStatus>;
}

interface CreateStreamOptions {
    /**
     * Opt into resume-on-reconnect for a stream the server declared `durable`.
     * The chunks already received are kept and the socket re-attaches to the same
     * run, so a dropped connection mid-generation continues instead of surfacing
     * `STREAM_DISCONNECTED`. Has no effect on an ephemeral stream.
     */
    durable?: boolean;
    /** Forwarded to `client.stream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;
    shardKey?: string;
}

/**
 * Subscribe to a streaming query. Returns the chunks pushed so far plus a
 * lifecycle status and a cancel function, all as accessors. Changing the
 * resolved `args` resets the stream — the previous iterator is cancelled and a
 * fresh one opens with empty `chunks`.
 *
 * `args` may be a plain value or an accessor; resolving it to `"skip"` keeps the
 * primitive mounted without opening a stream (mirrors `createSubscription`). The
 * Solid counterpart to React's `useStream`, re-expressed with signals.
 */
const createStream = <F extends FunctionReference<"stream">>(
    function_: F,
    args: ArgsOf<F> | "skip" | Accessor<ArgsOf<F> | "skip">,
    options: CreateStreamOptions = {},
): CreateStreamResult<ReturnOf<F>> => {
    const client = useLunora();

    const [chunks, setChunks] = createSignal<ReadonlyArray<ReturnOf<F>>>([]);
    const [error, setError] = createSignal<Error | undefined>(undefined);
    const [status, setStatus] = createSignal<CreateStreamStatus>("idle");

    const resolveArgs = typeof args === "function" ? (args as Accessor<ArgsOf<F> | "skip">) : () => args;

    // The live cancel handle for the currently-open stream, so a manual `cancel()`
    // and the effect's cleanup call into the same function.
    let cancelCurrent: (() => void) | undefined;

    const cancel = (): void => {
        cancelCurrent?.();
    };

    trackedEffect(resolveArgs, (currentArgs) => {
        // Reset for the new (or torn-down) stream.
        setChunks(() => []);
        setError(() => undefined);

        if (currentArgs === "skip") {
            setStatus("idle");

            return undefined;
        }

        setStatus("streaming");

        let active = true;
        const iterable = client.stream(function_, currentArgs, { durable: options.durable, maxBuffer: options.maxBuffer, shardKey: options.shardKey });
        const cancelIterable = (): void => {
            iterable.cancel();
        };

        cancelCurrent = cancelIterable;

        // Consume in a background async IIFE so the effect body stays
        // synchronous; the cancel handle is what the cleanup uses. The IIFE
        // owns its own try/catch so any error already lands in the signals; the
        // trailing `.catch` is a belt-and-braces guard that can never fire.
        (async () => {
            try {
                for await (const chunk of iterable) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` is flipped to `false` by the cleanup closure between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                    if (!active) {
                        return;
                    }

                    // Append immutably so consumers comparing by identity see a change.
                    setChunks((previous) => [...previous, chunk]);
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the cleanup closure while the iterator was awaiting; the guard is real, not dead.
                if (active) {
                    setStatus("complete");
                }
            } catch (streamError: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the cleanup closure while the iterator was awaiting; the guard is real, not dead.
                if (!active) {
                    return;
                }

                setError(() => (streamError instanceof Error ? streamError : new Error(String(streamError))));
                setStatus("error");
            }
        })().catch(() => {
            // Unreachable: the IIFE's own try/catch already routes errors into
            // the signals. This satisfies no-floating-promises.
        });

        return () => {
            active = false;
            cancelIterable();

            if (cancelCurrent === cancelIterable) {
                cancelCurrent = undefined;
            }
        };
    });

    onCleanup(() => {
        cancel();
    });

    return { cancel, chunks, error, status };
};

export type { CreateStreamOptions, CreateStreamResult, CreateStreamStatus };
export { createStream };
