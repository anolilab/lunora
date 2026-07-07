/**
 * Bounded async-iterator queue backing `LunoraClient.stream`.
 *
 * The server pushes one server `chunk` message per yielded value while the
 * client iterates with `for await (const chunk of stream)`. A producer that
 * outruns its consumer would otherwise OOM the page, so the buffer is bounded
 * — exceeding {@link DEFAULT_MAX_BUFFER} surfaces a `STREAM_BACKPRESSURE`
 * error to the iterator (and to the server-side cancel path).
 *
 * The queue is closed exactly once via {@link StreamHandle.complete} (success)
 * or {@link StreamHandle.fail} (transport / server error). Subsequent calls
 * are silent no-ops so a duplicate `complete` frame after a cancel doesn't
 * crash the page.
 */
import { LunoraError } from "@lunora/errors";

const DEFAULT_MAX_BUFFER = 1024;

interface StreamHandle<T = unknown> {
    /** Mark the stream complete (no more chunks); resolves any pending consumer to `done:true`. */
    readonly complete: () => void;
    /** Surface an error to any pending consumer; subsequent pushes are dropped. */
    readonly fail: (error: Error) => void;

    /**
     * Push one chunk. Silent no-op once the stream is `complete`, `fail`-ed,
     * or `cancel`-ed. When the buffer is already at `maxBuffer`, the stream
     * is failed with a `STREAM_BACKPRESSURE` error and the push is dropped —
     * the producer never sees a thrown exception.
     */
    readonly push: (value: T) => void;
}

interface StreamIterable<T> extends AsyncIterable<T> {
    /** Cancel the stream from the consumer side: closes the iterator and notifies the registered canceller. */
    cancel: () => void;
}

interface PendingResolve<T> {
    reject: (error: Error) => void;
    resolve: (value: IteratorResult<T>) => void;
}

/**
 * Build a stream handle paired with an async-iterable. The handle is the
 * server-driven side (the WS dispatcher pushes chunks / completes / errors);
 * the iterable is what the user awaits. `onCancel` is invoked exactly once
 * when the consumer calls `.cancel()` (or `.return()`) so the client can
 * send a `{type:"unsubscribe"}` frame to the server.
 */
const createStream = <T>(options: { maxBuffer?: number; onCancel: () => void }): { handle: StreamHandle<T>; iterable: StreamIterable<T> } => {
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const buffer: T[] = [];
    const pending: PendingResolve<T>[] = [];

    let done = false;
    let failure: Error | undefined;
    let cancelled = false;

    const flushOne = (): boolean => {
        const waiter = pending.shift();

        if (!waiter) {
            return false;
        }

        if (failure) {
            waiter.reject(failure);

            return true;
        }

        // Check length BEFORE shifting — a stream of `T = X | undefined` may
        // legitimately enqueue an `undefined` value, and `buffer.shift()`
        // alone returns `undefined` for both "I shifted an undefined" and
        // "buffer was empty". The length probe disambiguates so undefined
        // chunks are delivered instead of silently dropped.
        if (buffer.length > 0) {
            const value = buffer.shift() as T;

            waiter.resolve({ done: false, value });

            return true;
        }

        if (done) {
            waiter.resolve({ done: true, value: undefined });

            return true;
        }

        // Nothing to flush — put the waiter back at the head.
        pending.unshift(waiter);

        return false;
    };

    const handle: StreamHandle<T> = {
        complete() {
            if (done || failure) {
                return;
            }

            done = true;

            // Flush every pending waiter so they see done:true (or the buffered tail first).
            while (flushOne()) {
                /* keep flushing */
            }
        },
        fail(error) {
            if (done || failure) {
                return;
            }

            failure = error;
            // Drain buffered values — once a stream errors we deliver the error
            // immediately rather than handing out stale chunks.
            buffer.length = 0;

            while (flushOne()) {
                /* keep flushing */
            }
        },
        push(value) {
            if (done || failure || cancelled) {
                return;
            }

            if (buffer.length >= maxBuffer) {
                handle.fail(
                    new LunoraError(
                        "STREAM_BACKPRESSURE",
                        `stream buffer overflow (max=${maxBuffer.toString()}); the consumer cannot keep up with the producer`,
                    ),
                );

                return;
            }

            buffer.push(value);
            flushOne();
        },
    };

    const cancel = (): void => {
        if (cancelled) {
            return;
        }

        cancelled = true;
        done = true;
        buffer.length = 0;

        try {
            options.onCancel();
        } catch {
            /* swallow opaque cancel errors — the iterator is closing anyway */
        }

        while (flushOne()) {
            /* keep flushing */
        }
    };

    const iterable: StreamIterable<T> = {
        cancel,
        [Symbol.asyncIterator]() {
            return {
                next(): Promise<IteratorResult<T>> {
                    if (failure) {
                        return Promise.reject(failure);
                    }

                    if (buffer.length > 0) {
                        const value = buffer.shift() as T;

                        return Promise.resolve({ done: false, value });
                    }

                    if (done) {
                        return Promise.resolve({ done: true, value: undefined as unknown as T });
                    }

                    return new Promise<IteratorResult<T>>((resolve, reject) => {
                        pending.push({ reject, resolve });
                    });
                },
                return(): Promise<IteratorResult<T>> {
                    cancel();

                    return Promise.resolve({ done: true, value: undefined as unknown as T });
                },
            };
        },
    };

    return { handle, iterable };
};

export { createStream, DEFAULT_MAX_BUFFER };
export type { StreamHandle, StreamIterable };
