/**
 * Readiness probe for the worker `lunora dev` orchestrates.
 *
 * `.lunora/dev.json` is claimed before `wrangler dev` is spawned, so its `url`
 * is the origin the server INTENDS to serve on and its `pid` is a process that
 * merely exists. A supervisor running Lunora as one worker among several has no
 * way to tell that apart from a worker that is actually accepting requests, so
 * it either sleeps a guessed interval or races. This stamps `readyAt` onto the
 * record the moment the origin answers, giving that supervisor something to poll
 * instead.
 *
 * Any HTTP response counts, including 404 and 500: the question is whether
 * something is listening and speaking HTTP on that port, not whether the app
 * routes `/`. A fresh Worker with no root route answers 404 and is ready.
 *
 * A plain GET, deliberately — not a WebSocket upgrade. `@cloudflare/vite-plugin`
 * turns a non-101 upgrade response into a bare socket destroy, so a probe over
 * WS reports "connection failed" for a server that is up and answering.
 */
import { updateDevServerState } from "@lunora/config";

import type { Logger } from "./logger";

/** Gap between attempts. Short enough that readiness is not perceptibly late, long enough not to spin. */
const POLL_INTERVAL_MS = 250;

/**
 * How long to keep probing before giving up.
 *
 * Generous because the first request to `wrangler dev` pays for workerd booting
 * and the bundle compiling, and a large app on a cold cache can take tens of
 * seconds. Giving up only stops the probe — the dev server itself is unaffected,
 * and `readyAt` simply stays absent, which the field documents as "not ready
 * yet" rather than "never".
 */
const READY_TIMEOUT_MS = 120_000;

/** Resolve after `ms`, or immediately once `signal` aborts. Never rejects. */
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        let timer: NodeJS.Timeout;

        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };

        timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        // `unref` so a pending gap can't hold the process open past shutdown —
        // the dev server exiting must not wait on the probe's next tick.
        timer.unref();

        signal.addEventListener("abort", onAbort, { once: true });
    });

/**
 * Poll `origin` until it answers, then record `readyAt` on the dev-state record.
 *
 * Never throws and never rejects: this is metadata for whoever is watching, and
 * a probe failure must not disturb the dev server it is observing. Returns
 * whether readiness was recorded, so a caller (or a test) can tell "answered"
 * from "gave up / was cancelled" without re-reading the file.
 */
const markWorkerReadyWhenServing = async (options: {
    /** Project root holding `.lunora/dev.json`. */
    cwd: string;
    /** Injection seam for tests — defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    logger: Logger;
    /** The origin the worker serves on (`plan.workerOrigin`). */
    origin: string;
    /** Aborted on shutdown, so the loop stops with the server rather than outliving it. */
    signal: AbortSignal;
}): Promise<boolean> => {
    const { cwd, logger, origin, signal } = options;
    const request = options.fetchImpl ?? globalThis.fetch;
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (!signal.aborted && Date.now() < deadline) {
        try {
            // eslint-disable-next-line no-await-in-loop -- a readiness probe is sequential by definition; parallel attempts would just hammer a port that isn't open yet
            await request(origin, { method: "GET", signal });

            updateDevServerState(cwd, { readyAt: new Date().toISOString() });

            return true;
        } catch {
            // Not listening yet (ECONNREFUSED), or we were aborted. The loop
            // condition sorts the two out; anything else is retried the same way
            // because the only question this asks is "did it answer".
        }

        // eslint-disable-next-line no-await-in-loop -- the gap between attempts IS the loop
        await delay(POLL_INTERVAL_MS, signal);
    }

    // Only worth saying when we ran out of patience: a cancelled probe means the
    // server is shutting down, where a warning about readiness is noise.
    if (!signal.aborted) {
        logger.warn(
            `worker did not answer on ${origin} within ${String(Math.round(READY_TIMEOUT_MS / 1000))}s — ` +
                `.lunora/dev.json will have no readyAt. The server is still running; this only affects anything polling for readiness.`,
        );
    }

    return false;
};

export { markWorkerReadyWhenServing, POLL_INTERVAL_MS, READY_TIMEOUT_MS };
