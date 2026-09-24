/**
 * HTTP polling fallback for live queries on a network that blocks WebSockets.
 *
 * Lunora's one-shot calls (`query` / `mutation` / `action`) already ride HTTP
 * POST, so a corporate proxy or captive network that refuses the `Upgrade`
 * handshake does not break them — it breaks **reactivity**, and only that. Every
 * live query bound to the shard simply stops moving, the status indicator reads
 * `"connecting"` forever, and nothing says why.
 *
 * This controller closes that gap the cheapest way that keeps data flowing: after
 * a run of connect attempts that never reach `open`, the client stops relying on
 * the socket for freshness and re-runs each active subscription's query over the
 * existing batch-RPC endpoint on an interval, feeding the results into the very
 * same frame-apply path a server `data` frame takes. When a socket finally does
 * open, polling stops and the normal resubscribe handshake takes over.
 *
 * # What this is not
 *
 * It is a **degradation, not a second transport**, and the difference is worth
 * stating because the gap it leaves is not obvious from the outside:
 *
 * Only plain live queries are polled — **shapes** (`@lunora/db` collections),
 * **durable streams** and **whispers** are WebSocket-only surfaces with no
 * request/response equivalent to re-run, so they stay dark for as long as the
 * socket does. Freshness is bounded by the interval, not by the write: there is no
 * CDC cursor on this path, so each tick carries a full snapshot and a poll costs
 * what the query costs, repeatedly. And it does not make an app offline-capable —
 * a poll is an HTTP request, so when nothing can reach the origin the offline
 * queue is what carries you.
 *
 * So the honest summary for a UI: `"polling"` means *live, but slower and
 * partial*, which is why it is a distinct `ConnectionStatus` rather than being
 * folded into `"connected"`.
 *
 * # Why "failed to open", not "closed"
 *
 * The trigger is deliberately a run of attempts that never reached `open`, not a
 * run of disconnects. A socket that opens and drops is a flaky network, and the
 * reconnect backoff is the right answer to that — falling back to polling would
 * trade a self-healing channel for a permanently worse one. A socket that never
 * opens at all is the signature of something refusing the upgrade, which no
 * amount of retrying fixes.
 */

/** Knobs for {@link createPollingFallback}. */
export interface PollingFallbackOptions {
    /**
     * Consecutive connect attempts that must fail to reach `open` before polling
     * starts. More than one so a single cold-start timeout or a deploy bounce
     * does not flip a healthy client onto the slow path.
     */
    readonly afterFailedAttempts: number;

    /** Interval between polls, in ms. */
    readonly intervalMs: number;

    /** Re-read the state (i.e. recompute + emit the aggregate connection status). */
    readonly onStateChange: () => void;

    /** Run one poll pass. Rejections are swallowed — a failed tick just waits for the next. */
    readonly poll: () => Promise<void>;
}

/** The polling state machine for ONE shard connection. */
export interface PollingFallback {
    /** `true` while the interval is armed. */
    isPolling: () => boolean;
    /** A connect attempt ended without ever reaching `open`. Starts polling at the threshold. */
    noteFailedOpen: () => void;
    /** A connect attempt reached `open`: reset the run and stop polling. */
    noteOpen: () => void;
    /** Stop polling and clear the timer (client close / connection teardown). Keeps the failure run. */
    stop: () => void;
}

/**
 * Build the polling state machine for one connection. Inert when `intervalMs` is
 * `0` or less — `noteFailedOpen` then only counts, and `isPolling` is always
 * `false`, so the client behaves exactly as it did before this existed.
 */
export const createPollingFallback = (options: PollingFallbackOptions): PollingFallback => {
    const { afterFailedAttempts, intervalMs, onStateChange, poll } = options;
    const enabled = intervalMs > 0 && afterFailedAttempts > 0;

    let failures = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Ticks must not overlap: a poll slower than the interval would otherwise
    // stack requests on a link that is already the reason we are here.
    let inFlight = false;

    const tick = (): void => {
        if (inFlight) {
            return;
        }

        inFlight = true;

        // `finally` before `catch`, deliberately: `finally` passes a rejection
        // through, so the flag is always cleared AND the rejection is still
        // swallowed by the trailing `catch`. A failed pass is not fatal — the
        // next tick retries.
        poll()
            .finally(() => {
                inFlight = false;
            })
            .catch(() => {
                /* reported nowhere: the caller's own error path owns this */
            });
    };

    const stop = (): void => {
        if (timer === undefined) {
            return;
        }

        clearInterval(timer);
        timer = undefined;
        onStateChange();
    };

    return {
        isPolling: () => timer !== undefined,
        noteFailedOpen: () => {
            failures += 1;

            if (!enabled || timer !== undefined || failures < afterFailedAttempts) {
                return;
            }

            timer = setInterval(tick, intervalMs);
            onStateChange();

            // Poll immediately rather than making the first value wait a full
            // interval: by this point the subscriptions have already been stale
            // for several failed connect attempts.
            tick();
        },
        noteOpen: () => {
            failures = 0;
            stop();
        },
        stop,
    };
};
