import { TransportError } from "./errors";

/**
 * The rejection a caller's `AbortSignal` produces: its own `reason`, or the
 * platform's `AbortError` when it carries none. Never a {@link TransportError} —
 * the caller walked away, so nothing about it is retryable.
 */
const abortReason = (signal: AbortSignal): Error => (signal.reason as Error | undefined) ?? new DOMException("The operation was aborted", "AbortError");

/**
 * Run one HTTP exchange under a deadline and an optional caller signal.
 *
 * `run` receives a signal that is aborted when either fires, and should cover the
 * WHOLE exchange (the `fetch` and the body read): a body that stalls after the
 * headers arrive holds a request open just as long as a connection that never
 * answers. The race is explicit, not left to the signal, so a `fetch` double that
 * ignores `abort` still lets go.
 *
 * A deadline that fires rejects with a {@link TransportError}. Its fate on the
 * server is unknown — the write may well have committed — so it is the same
 * "retry under the same idempotency key" failure an unreadable edge page is,
 * where a bare `AbortError` would read as a verdict. `timeoutMs <= 0` disables
 * the deadline.
 */
const withinRpcDeadline = async <T>(timeoutMs: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (signal?.aborted) {
        throw abortReason(signal);
    }

    const controller = new AbortController();
    const cleanup: (() => void)[] = [];
    const interruption = new Promise<never>((_resolve, reject) => {
        if (timeoutMs > 0) {
            const timer = setTimeout(() => {
                controller.abort();
                reject(new TransportError(`LunoraClient: request timed out after ${timeoutMs.toString()}ms`));
            }, timeoutMs);

            cleanup.push(() => {
                clearTimeout(timer);
            });
        }

        if (signal) {
            const onAbort = (): void => {
                controller.abort();
                reject(abortReason(signal));
            };

            signal.addEventListener("abort", onAbort, { once: true });
            cleanup.push(() => {
                signal.removeEventListener("abort", onAbort);
            });
        }
    });

    // `run` may lose the race and reject later (its fetch aborted): that rejection is not ours to surface.
    const exchange = run(controller.signal);

    exchange.catch(() => undefined);

    try {
        return await Promise.race([exchange, interruption]);
    } finally {
        for (const undo of cleanup) {
            undo();
        }
    }
};

export default withinRpcDeadline;
