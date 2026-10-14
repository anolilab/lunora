/**
 * Spend pause: a receiver for Cloudflare usage alerts that stops the app until
 * an operator resumes it, and the guard that enforces the stop.
 *
 * A Cloudflare usage alert only notifies. This module closes that gap: an alert
 * delivered to `POST /_lunora/spend-alert` sets a flag in an R2 bucket, and while
 * the flag is set `withSpendGuard` answers user traffic with 503 and skips cron
 * jobs. Nothing clears the flag. Resuming is a deliberate operator action (see the
 * README).
 */

/** The receiver. Cloudflare posts each alert here; the secret travels in `cf-webhook-auth`. */
const SPEND_ALERT_PATH = "/_lunora/spend-alert";

/** The R2 object whose presence means the app is paused. */
const SPEND_PAUSED_KEY = "spend-paused";

/** The `alert_type` of a Usage Based Billing alert, as the policy names it. */
const USAGE_ALERT_TYPE = "billing_usage_alert";

/** The header Cloudflare copies the webhook destination's secret into, on every delivery. */
const SECRET_HEADER = "cf-webhook-auth";

/** Health probes stay up while paused, so an uptime monitor still sees the app. */
const HEALTH_PATHS: ReadonlySet<string> = new Set(["/_lunora/health", "/_lunora/health/ready"]);

/**
 * Internal dispatch receivers, deliberately not gated: the scheduler and the
 * platform queue forwarder retry any non-2xx answer, so a 503 here would turn the
 * pause into a retry backlog. Those jobs keep running; see the README.
 */
const DISPATCH_PATHS: ReadonlySet<string> = new Set(["/_lunora/scheduler/dispatch", "/_lunora/queue"]);

/** An alert body is a few hundred bytes; anything larger is not one. */
const MAX_ALERT_BYTES = 16 * 1024;

/** The bindings this item reads. `SPEND_GUARD` is the R2 bucket; the secret is set with `wrangler secret put`. */
interface SpendGuardEnv {
    SPEND_GUARD?: SpendStoreLike;
    SPEND_GUARD_SECRET?: string;
}

/** The slice of an R2 bucket the guard uses. A structural type, so this file needs no Workers types. */
interface SpendStoreLike {
    head: (key: string) => Promise<unknown>;
    put: (key: string, value: string) => Promise<unknown>;
}

/**
 * Equality that takes the same time whatever the first difference is, and folds a
 * length mismatch into the same accumulator. Mirrors `shared/constant-time-equal.ts`
 * in the Lunora repository; a copy-in item cannot import from there.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
    const max = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;

    for (let index = 0; index < max; index += 1) {
        diff |= (index < a.length ? a.charCodeAt(index) : 0) ^ (index < b.length ? b.charCodeAt(index) : 0);
    }

    return diff === 0;
};

/** How long an isolate trusts its last read of the pause flag, so a request costs an R2 read at most once per window. */
const PAUSE_CACHE_MS = 30_000;

const pauseReads = new WeakMap<object, { at: number; paused: boolean }>();

const isPaused = async (env: SpendGuardEnv | undefined): Promise<boolean> => {
    const bucket = env?.SPEND_GUARD;

    if (bucket === undefined) {
        return false;
    }

    const cached = pauseReads.get(bucket);

    if (cached !== undefined && Date.now() - cached.at < PAUSE_CACHE_MS) {
        return cached.paused;
    }

    const paused = (await bucket.head(SPEND_PAUSED_KEY)) !== null;

    pauseReads.set(bucket, { at: Date.now(), paused });

    return paused;
};

const pausedResponse = (): Response => new Response("Service unavailable", { headers: { "retry-after": "3600" }, status: 503 });

const readAlertBody = async (request: Request): Promise<string | undefined> => {
    if (Number(request.headers.get("content-length") ?? "0") > MAX_ALERT_BYTES) {
        return undefined;
    }

    const text = await request.text();

    return text.length > MAX_ALERT_BYTES ? undefined : text;
};

const alertTypeOf = (text: string): unknown => {
    try {
        const parsed: unknown = JSON.parse(text);

        return typeof parsed === "object" && parsed !== null ? (parsed as { alert_type?: unknown }).alert_type : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Verify and act on one delivery. Fails closed: with no secret configured every
 * request is refused, so an unconfigured app can never be paused by a stranger.
 * Only a delivery whose `alert_type` is a usage alert pauses the app. Cloudflare's
 * documented test message has no `alert_type`, so the dashboard's Save and Test
 * cannot take production down.
 */
const handleSpendAlert = async (request: Request, env: SpendGuardEnv): Promise<Response> => {
    if (request.method !== "POST") {
        return new Response(null, { headers: { allow: "POST" }, status: 405 });
    }

    const secret = env.SPEND_GUARD_SECRET;

    if (secret === undefined || secret.length === 0 || !constantTimeEqual(request.headers.get(SECRET_HEADER) ?? "", secret)) {
        return new Response(null, { status: 403 });
    }

    if (env.SPEND_GUARD === undefined) {
        return new Response("SPEND_GUARD binding is not configured", { status: 500 });
    }

    const text = await readAlertBody(request);

    if (text === undefined) {
        return new Response(null, { status: 413 });
    }

    if (alertTypeOf(text) !== USAGE_ALERT_TYPE) {
        // Authenticated but not a usage alert: acknowledged, nothing paused. Logged so an operator can see what arrived.
        console.warn(`spend-alert: ignored a delivery whose alert_type is not ${USAGE_ALERT_TYPE}`);

        return new Response(null, { status: 202 });
    }

    if (await isPaused(env)) {
        return new Response(null, { status: 200 });
    }

    await env.SPEND_GUARD.put(SPEND_PAUSED_KEY, JSON.stringify({ pausedAt: new Date().toISOString() }));
    pauseReads.set(env.SPEND_GUARD, { at: Date.now(), paused: true });
    console.warn("spend-alert: usage alert received; the app is paused until the spend-paused object is deleted");

    return new Response(null, { status: 200 });
};

interface WorkerLike {
    fetch: (request: Request, env: unknown, context: unknown) => Promise<Response> | Response;
    scheduled: (controller: unknown, env: unknown, context: unknown) => Promise<void> | void;
}

/**
 * Wrap a Worker so a verified usage alert pauses it. Spread, so `queue`, `email`
 * and any other entry the Worker exports pass through unchanged.
 *
 *     export default withSpendGuard(createWorker({ ... }));
 */
const withSpendGuard = <W extends WorkerLike>(worker: W): W => ({
    ...worker,
    fetch: async (request, env, context) => {
        const { pathname } = new URL(request.url);

        if (pathname === SPEND_ALERT_PATH) {
            return handleSpendAlert(request, env as SpendGuardEnv);
        }

        if (!HEALTH_PATHS.has(pathname) && !DISPATCH_PATHS.has(pathname) && (await isPaused(env as SpendGuardEnv | undefined))) {
            return pausedResponse();
        }

        return worker.fetch(request, env, context);
    },
    scheduled: async (controller, env, context) => {
        if (await isPaused(env as SpendGuardEnv | undefined)) {
            return;
        }

        return worker.scheduled(controller, env, context);
    },
});

export { SPEND_ALERT_PATH, SPEND_PAUSED_KEY, withSpendGuard };
