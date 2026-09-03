/**
 * A minimal, dependency-free batching buffer for telemetry exports — the piece
 * that turns "one HTTP subrequest per span" into "one per invocation".
 *
 * Bundler-inlined (like {@link file://./otlp.ts}) so the worker sink
 * (`@lunora/runtime`) and the container exporter (`@lunora/container`) share one
 * implementation without a runtime dependency edge between them.
 *
 * **Why this exists.** A Cloudflare Worker is capped at 50 (free) / 1000 (paid)
 * subrequests per invocation, and every `fetch` pays a TLS handshake. A handler
 * with twenty `ctx.trace` spans and thirty `ctx.log` lines that exports each one
 * individually spends fifty of that budget on telemetry and adds fifty
 * round-trips of tail latency — for data the collector wants as one batch
 * anyway. This is the OTel `BatchSpanProcessor` idea, reduced to what a Workers
 * isolate actually needs: no background thread, no unbounded queue, no retry
 * state machine.
 *
 * **Lifetime.** A Workers isolate can be frozen the moment the response is
 * returned, so a timer alone is not a safe flush trigger — the isolate may never
 * wake to run it. Every path that can start a timer therefore hands its pending
 * drain to the caller's `keepAlive` (the request's `waitUntil`), and the runtime
 * additionally force-flushes at the end of each invocation. The timer is the
 * backstop for contexts with no invocation boundary (a Durable Object between
 * requests), not the primary mechanism.
 *
 * Keep this genuinely zero-dependency (only built-ins) so inlining stays sound.
 */

/** Register a promise that must outlive the response (the request's `waitUntil`). */
export type KeepAlive = (promise: Promise<unknown>) => void;

export interface SignalBatcherOptions<T> {
    /**
     * Ship the buffered items. Called with a non-empty array, never concurrently
     * re-entered for the same batch. Rejections are swallowed by the batcher —
     * a failed export must never surface to the code being instrumented.
     */
    export: (items: T[]) => Promise<void> | void;

    /**
     * Flush this long after the FIRST item of a batch is buffered. A backstop
     * for contexts without an invocation boundary; `flush()` is the primary
     * trigger. Default 200ms — long enough to coalesce a whole handler, short
     * enough that a long-lived Durable Object doesn't sit on stale telemetry.
     */
    maxDelayMs?: number;

    /**
     * Flush as soon as the buffer reaches this many items, without waiting.
     * Bounds both the batch body size and, since the buffer is dropped-oldest
     * beyond it, the memory a runaway loop of spans can hold. Default 512.
     *
     * **Precondition: a positive integer.** Not validated here — this file is
     * bundler-inlined and must stay free of `@lunora/errors`, so the one caller
     * that takes the value from operator config (`otlpSink`'s `batch.maxItems`)
     * rejects a bad one with a catalogued `ENV_INVALID` before it reaches this
     * constructor. It matters because the failure modes are unrecoverable, not
     * merely wrong: a NEGATIVE cap turns the drop-oldest `while` in `add` into a
     * synchronous infinite loop that hangs the isolate on its first telemetry
     * event, and `0` / a fraction empties the buffer before the drain can read
     * it, so every signal is silently discarded.
     */
    maxItems?: number;
}

export interface SignalBatcher<T> {
    /** Buffer one item. `keepAlive` keeps the isolate alive for a timer-driven drain. */
    add: (item: T, keepAlive?: KeepAlive) => void;

    /** Number of items currently buffered — for tests and diagnostics. */
    readonly size: number;

    /**
     * Drain now. Returns the export's promise so a caller that must not race it
     * (a Durable Object's dispatch `finally`) can await, though the common path
     * is fire-and-forget via `keepAlive`.
     */
    flush: (keepAlive?: KeepAlive) => Promise<void>;
}

const DEFAULT_MAX_ITEMS = 512;
const DEFAULT_MAX_DELAY_MS = 200;

/**
 * Create a batching buffer for one signal (spans, logs, or metrics).
 *
 * Deliberately NOT a queue with retries. A Workers isolate can vanish between
 * the buffer and the network, so durability is the collector's problem, not
 * ours; adding retry state here would trade a bounded, understandable data loss
 * for an unbounded memory risk inside the request path.
 */
export const createSignalBatcher = <T>(options: SignalBatcherOptions<T>): SignalBatcher<T> => {
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

    let buffer: T[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * The in-flight drain for the CURRENT batch window, handed to every
     * `keepAlive` that arrives while the window is open. One shared promise
     * rather than one per item: `waitUntil` is happy to receive the same promise
     * repeatedly, and this keeps the registration count off the hot path.
     */
    let pending: Promise<void> | undefined;
    let settlePending: (() => void) | undefined;

    const clearTimer = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const drain = async (): Promise<void> => {
        clearTimer();

        const items = buffer;

        buffer = [];

        // Release the window BEFORE awaiting the export: items buffered while
        // the export is in flight belong to the next batch, and must be able to
        // open their own window rather than attach to one that is already
        // draining.
        const settle = settlePending;

        pending = undefined;
        settlePending = undefined;

        try {
            if (items.length > 0) {
                await options.export(items);
            }
        } catch {
            // Swallowed by contract — a flaky collector must never reach the
            // instrumented code. Deliberately not `console.error`: in a Workers
            // runtime that lands in the platform error log and creates exactly
            // the noise loop this whole pipeline exists to avoid.
        } finally {
            settle?.();
        }
    };

    /** Open (or re-use) the current batch window and register it with `keepAlive`. */
    const openWindow = (keepAlive: KeepAlive | undefined): void => {
        if (pending === undefined) {
            pending = new Promise<void>((resolve) => {
                settlePending = resolve;
            });

            timer = setTimeout(() => {
                void drain();
            }, maxDelayMs);
        }

        keepAlive?.(pending);
    };

    return {
        add: (item: T, keepAlive?: KeepAlive): void => {
            buffer.push(item);

            // Drop-oldest above the cap. The alternative — drop the newest —
            // discards the span that just told you something changed, and an
            // unbounded buffer risks OOMing the isolate on a pathological loop.
            //
            // A backstop, not a routine path, and deliberately uncounted because
            // of it: the `drain()` below fires at exactly `maxItems` and empties
            // the buffer SYNCHRONOUSLY (it reassigns `buffer` before its first
            // await), so nothing here is reachable while that holds. A change
            // that empties the buffer later — after an await, or behind an
            // in-flight guard — would start discarding telemetry silently, which
            // is what `otlp-batch.test.ts` pins.
            while (buffer.length > maxItems) {
                buffer.shift();
            }

            openWindow(keepAlive);

            if (buffer.length >= maxItems) {
                void drain();
            }
        },

        flush: async (keepAlive?: KeepAlive): Promise<void> => {
            if (buffer.length === 0) {
                clearTimer();

                return;
            }

            const drained = drain();

            keepAlive?.(drained);

            return drained;
        },

        get size(): number {
            return buffer.length;
        },
    };
};
