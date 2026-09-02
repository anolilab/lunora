import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import type { Readable } from "svelte/store";
import { readable, writable } from "svelte/store";

import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";

/** The lifecycle of a stream the store is observing. */
type StreamStatus = "complete" | "error" | "idle" | "streaming";

interface StreamStoreOptions {
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

interface StreamHandle<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;
    /** Svelte readable store of the chunks the server has pushed so far, in arrival order. */
    chunks: Readable<ReadonlyArray<T>>;
    /** Svelte readable store of the last stream error (`undefined` when healthy). */
    error: Readable<Error | undefined>;
    /** Svelte readable store of the stream lifecycle status. */
    status: Readable<StreamStatus>;

    /**
     * Stop the stream and release the iterator. Call in `onDestroy`
     * (`onDestroy(handle.teardown)`) when you consume `chunks` eagerly; when you
     * read `chunks` with `$` the store tears itself down as the last subscriber
     * leaves.
     */
    teardown: () => void;
}

/**
 * Open a streaming query and expose its chunks, lifecycle status, and last error
 * as Svelte readable stores. The `chunks` store is lazy: the stream opens on the
 * first subscriber to `chunks` and is cancelled when the last one leaves (its
 * chunks reset on the next open). `status` and `error` mirror that same stream.
 *
 * Passing `"skip"` as `args` keeps the stores connected but the stream dormant
 * (`chunks` stays empty, `status` stays `"idle"`). The Svelte counterpart to
 * React's `useStream`, re-expressed as stores you read with `$`.
 *
 * Pass an explicit `client` as the first argument to bypass the ambient context
 * (useful in tests), or omit it to resolve the client published by
 * `setLunoraClient`.
 */
function stream<F extends FunctionReference<"stream">>(function_: F, args: ArgsOf<F> | "skip", options?: StreamStoreOptions): StreamHandle<ReturnOf<F>>;
function stream<F extends FunctionReference<"stream">>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F> | "skip",
    options?: StreamStoreOptions,
): StreamHandle<ReturnOf<F>>;
function stream<F extends FunctionReference<"stream">>(
    clientOrFunction: F | LunoraClient,
    functionOrArgs: F | ArgsOf<F> | "skip",
    argsOrOptions?: ArgsOf<F> | StreamStoreOptions | "skip",
    maybeOptions?: StreamStoreOptions,
): StreamHandle<ReturnOf<F>> {
    // Resolve overloads: when the second argument is a FunctionReference, the
    // first must be an explicit LunoraClient; otherwise use the ambient context.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArgs : clientOrFunction) as F;
    const args = (hasExplicitClient ? argsOrOptions : functionOrArgs) as ArgsOf<F> | "skip";
    const options = (hasExplicitClient ? maybeOptions : (argsOrOptions as StreamStoreOptions | undefined)) ?? {};

    const { durable, maxBuffer, shardKey } = options;

    // Writable status/error stores the chunks store's start/stop callback drives,
    // so all three stores mirror the one underlying stream.
    const statusStore = writable<StreamStatus>("idle");
    const errorStore = writable<Error | undefined>();

    // The live cancel handle for the currently-open stream, so a manual `cancel()`
    // and the store's stop callback call into the same function.
    let cancelCurrent: (() => void) | undefined;

    const cancel = (): void => {
        cancelCurrent?.();
    };

    const chunks = readable<ReadonlyArray<ReturnOf<F>>>([], (set) => {
        // Reset for the (re-)opened stream.
        set([]);
        errorStore.set(undefined);

        if (args === "skip") {
            statusStore.set("idle");

            return () => undefined;
        }

        statusStore.set("streaming");

        let active = true;
        let current: ReadonlyArray<ReturnOf<F>> = [];
        const iterable = client.stream(functionRef, args, { durable, maxBuffer, shardKey });
        const cancelIterable = (): void => {
            iterable.cancel();
        };

        cancelCurrent = cancelIterable;

        // Consume in a background async IIFE so the start callback stays
        // synchronous; the cancel handle is what the stop callback uses. The IIFE
        // owns its own try/catch so any error already lands in the stores; the
        // trailing `.catch` is a belt-and-braces guard that can never fire.
        (async () => {
            try {
                for await (const chunk of iterable) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` is flipped to `false` by the stop closure between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                    if (!active) {
                        return;
                    }

                    // Append immutably so consumers comparing by identity see a change.
                    current = [...current, chunk];
                    set(current);
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the stop closure while the iterator was awaiting; the guard is real, not dead.
                if (active) {
                    statusStore.set("complete");
                }
            } catch (streamError: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by the stop closure while the iterator was awaiting; the guard is real, not dead.
                if (!active) {
                    return;
                }

                errorStore.set(streamError instanceof Error ? streamError : new Error(String(streamError)));
                statusStore.set("error");
            }
        })().catch(() => {
            // Unreachable: the IIFE's own try/catch already routes errors into the
            // stores. This satisfies no-floating-promises.
        });

        return () => {
            active = false;
            cancelIterable();

            if (cancelCurrent === cancelIterable) {
                cancelCurrent = undefined;
            }
        };
    });

    const teardown = (): void => {
        cancel();
    };

    return { cancel, chunks, error: { subscribe: errorStore.subscribe }, status: { subscribe: statusStore.subscribe }, teardown };
}

export type { StreamHandle, StreamStatus, StreamStoreOptions };
export { stream };
