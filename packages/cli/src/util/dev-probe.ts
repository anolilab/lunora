/**
 * Is a dev server accepting requests yet?
 *
 * One answer, shared by everything that asks. `lunora dev --background` blocks
 * on it before printing its banner, and the foreground run stamps `readyAt` onto
 * `.lunora/dev.json` from it. Those two lived apart and disagreed: one probed
 * `/_lunora/status` with a per-attempt timeout, the other GET'd `/` with none, so
 * "ready" meant something different depending on which command you asked.
 */

/** How long a caller waits for a server to accept requests before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 120_000;

/** Poll cadence for readiness / process-death checks. */
const POLL_INTERVAL_MS = 250;

/**
 * Per-attempt budget. Node's `fetch` has no timeout of its own, so without this
 * a server that ACCEPTS the connection and then stalls — `wrangler dev` binding
 * the port before workerd finishes compiling the bundle, or a root handler
 * awaiting a remote binding — pins the request open forever. The overall
 * deadline is only consulted between attempts, so one hung request outlives it
 * and the caller's timeout never fires at all.
 */
const ATTEMPT_TIMEOUT_MS = 1000;

/** Env overriding {@link DEFAULT_READY_TIMEOUT_MS}. */
const READY_TIMEOUT_ENV = "LUNORA_DEV_READY_TIMEOUT_MS";

/**
 * Readiness probe seam — tests swap the real HTTP probe out.
 *
 * The optional `signal` lets a caller cancel an attempt already in flight. Its
 * absence is why a teardown used to leave one request dangling for up to
 * {@link ATTEMPT_TIMEOUT_MS} after the dev server had been told to stop.
 */
type ReadinessProbe = (origin: string, signal?: AbortSignal) => Promise<boolean>;

/**
 * The caller-facing ready timeout: an explicit value, else
 * {@link READY_TIMEOUT_ENV}, else {@link DEFAULT_READY_TIMEOUT_MS}.
 *
 * Shared so raising the env var on a slow machine moves every readiness wait
 * together. It used to reach only `--background`, so a developer who set it
 * still got "did not answer within 120s" from the foreground stamp.
 */
const resolveReadyTimeoutMs = (explicit?: number): number => {
    if (explicit !== undefined) {
        return explicit;
    }

    const fromEnvironment = Number(process.env[READY_TIMEOUT_ENV] ?? "");

    return Number.isFinite(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : DEFAULT_READY_TIMEOUT_MS;
};

/**
 * True when a dev server answers at `origin` — ANY response counts, including a
 * 404: the question is whether something is listening and speaking HTTP, not
 * whether the app routes that path. Only a refused or failed connection is "not
 * ready".
 *
 * Targets `/_lunora/status`, the runtime's public health route, and NOT `/`. An
 * older runtime without that route still proves it is up by answering at all,
 * and the developer's own root handler is never invoked — which matters most
 * under `lunora dev --remote`, where the local worker's bindings point at the
 * DEPLOYED D1/KV/R2. A root handler that writes (a hit counter, an audit row, a
 * rate-limit bucket) would otherwise fire against production resources on every
 * dev start, unprompted.
 *
 * `redirect: "manual"` for the same reason: a `/` that 302s to a marketing page
 * or an OAuth provider would make the dev machine call that host on every start.
 * A liveness check must not follow anyone anywhere.
 */
const defaultProbe = async (origin: string, signal?: AbortSignal): Promise<boolean> => {
    try {
        // The per-attempt budget AND the caller's cancellation, whichever fires
        // first: the timeout alone bounds a stalled server, but only the caller's
        // signal ends an attempt the moment the thing being probed is shutting
        // down.
        const attempt = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
        const response = await fetch(new URL("/_lunora/status", origin), {
            redirect: "manual",
            signal: signal === undefined ? attempt : AbortSignal.any([signal, attempt]),
        });

        // Undici keeps the socket checked out until an unread body is GC'd.
        // One request, so the leak is small, but releasing it is free.
        await response.body?.cancel();

        return true;
    } catch {
        return false;
    }
};

export type { ReadinessProbe };
export { ATTEMPT_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, defaultProbe, POLL_INTERVAL_MS, READY_TIMEOUT_ENV, resolveReadyTimeoutMs };
