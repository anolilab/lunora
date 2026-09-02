import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";

import { resolveLunoraClient } from "./client";

/**
 * The lifecycle of a stream the primitive is observing.
 * @experimental
 */
export type StreamStatus = "complete" | "error" | "idle" | "streaming";

/**
 * `StreamOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface StreamOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` cancels the stream. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /**
     * Opt into resume-on-reconnect for a stream the server declared `durable`.
     * The chunks already received are kept and the socket re-attaches to the same
     * run, so a dropped connection mid-generation continues instead of surfacing
     * `STREAM_DISCONNECTED`. Has no effect on an ephemeral stream.
     */
    durable?: boolean;

    /** Forwarded to `client.stream()` — caps the in-flight chunk buffer. */
    maxBuffer?: number;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * `StreamResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface StreamResult<T> {
    /** Force-cancel the stream and resolve the iterator. Safe to call multiple times. */
    cancel: () => void;

    /** Chunks the server has pushed so far, in arrival order. */
    chunks: Signal<ReadonlyArray<T>>;

    /** The stream error, or `undefined`. */
    error: Signal<Error | undefined>;

    /** The stream lifecycle. */
    status: Signal<StreamStatus>;
}

/**
 * Subscribe to a streaming query. Returns the chunks pushed so far plus a
 * lifecycle status and a `cancel` function, all as signals.
 *
 * Unlike `subscription`, which tracks the latest value, `stream` accumulates every
 * chunk the server pushes — use it for token-by-token deltas and other append-only
 * feeds. Pass `"skip"` as `args` to keep the primitive mounted without opening a
 * stream (mirrors `subscription`); the stream tears down when the owning
 * `DestroyRef` fires. The Angular counterpart to React's `useStream`, re-expressed
 * with signals.
 *
 * Call from an injection context (component/service field or constructor):
 * ```ts
 * readonly tokens = stream(api.chat.liveEvents, { key: "thread-1" });
 * ```
 * @experimental
 */
export const stream = <F extends FunctionReference<"stream">>(
    reference: F,
    args: ArgsOf<F> | "skip",
    options: StreamOptions = {},
): StreamResult<ReturnOf<F>> => {
    const client = resolveLunoraClient(options.client);
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const chunks = signal<ReadonlyArray<ReturnOf<F>>>([]);
    const error = signal<Error | undefined>(undefined);
    const status = signal<StreamStatus>("idle");

    // Flipped to `false` by `cancel` (manual or on destroy) so the background
    // consumer stops appending once the primitive is torn down.
    let active = true;
    let cancelIterable: (() => void) | undefined;

    const cancel = (): void => {
        active = false;
        cancelIterable?.();
    };

    if (args !== "skip") {
        status.set("streaming");

        const iterable = client.stream(reference, args, { durable: options.durable, maxBuffer: options.maxBuffer, shardKey: options.shardKey });

        cancelIterable = (): void => {
            iterable.cancel();
        };

        // Consume in a background async IIFE so the primitive body stays
        // synchronous; the IIFE owns its own try/catch so any error already lands in
        // the signals, and the trailing `.catch` is a belt-and-braces guard that can
        // never fire.
        (async () => {
            try {
                for await (const chunk of iterable) {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` is flipped to `false` by `cancel` between awaits; TS's static flow analysis can't see the async mutation, so this guard is real, not dead.
                    if (!active) {
                        return;
                    }

                    // Append immutably so consumers comparing by identity see a change.
                    chunks.update((current) => [...current, chunk]);
                }

                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by `cancel` while the iterator was awaiting; the guard is real, not dead.
                if (active) {
                    status.set("complete");
                }
            } catch (streamError: unknown) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` may have been flipped to `false` by `cancel` while the iterator was awaiting; the guard is real, not dead.
                if (!active) {
                    return;
                }

                error.set(streamError instanceof Error ? streamError : new Error(String(streamError)));
                status.set("error");
            }
        })().catch(() => {
            // Unreachable: the IIFE's own try/catch already routes errors into the
            // signals. This satisfies no-floating-promises.
        });
    }

    destroyRef.onDestroy(cancel);

    return { cancel, chunks: chunks.asReadonly(), error: error.asReadonly(), status: status.asReadonly() };
};
