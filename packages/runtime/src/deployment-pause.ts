/**
 * Deployment pause: the operator's incident switch that stops function calls,
 * scheduled jobs, cron runs and queue consumers without a redeploy, and starts
 * them again on resume.
 *
 * The flag is durable and lives in the `SchedulerDO` (`GET`/`POST /pause`),
 * which holds scheduled jobs and skips cron ticks itself. The worker reads it
 * for the request router and the queue consumer. A worker with no `schedulerDO`
 * cannot pause, and says so (`PAUSE_NOT_CONFIGURED`) rather than pretending to.
 *
 * **Where it does not reach:** a realtime socket opened before the pause lives
 * in its shard and never passes through the worker again, so it keeps serving
 * subscriptions until it reconnects (writes go over HTTP and are refused); jobs
 * on a separately named scheduler instance read their own instance's flag; HTTP
 * actions and SSR behind `httpRouter` are not gated; the built-in scheduled
 * backup keeps running (it executes no app code).
 *
 * **What stays reachable while paused:** the admin plane and any call carrying
 * the admin bearer — Studio's data browser and the CLI run through the same RPC
 * path, and the operator must be able to inspect and resume — plus health
 * probes, auth, and the scheduler's own dispatch callback (the DO stops
 * dispatching on its own; refusing a dispatch already in flight would only
 * charge it a retry).
 */
import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";
import type { ResolvedShard } from "./resolve-shard";

const PAUSE_PATH = "/_lunora/admin/pause";

/**
 * How long one isolate trusts its last read of the flag. A pause therefore
 * reaches every isolate within this window, and the isolate that set it at once.
 */
// ponytail: a per-isolate TTL read costs one SchedulerDO GET per isolate per window; push the flag to isolates if that read ever shows up.
const PAUSE_CACHE_MS = 5000;

/** Seconds a paused caller is told to wait before retrying. */
const PAUSED_RETRY_AFTER_SECONDS = 30;

/** Whether the deployment is paused. Mirrors `@lunora/scheduler`'s `DeploymentPauseState`. */
interface DeploymentPauseState {
    paused: boolean;
    pausedAt?: number;
    reason?: string;
}

interface DeploymentPauseOptions {
    /** Admin-gate a request; throws when unauthorized. */
    assertAdmin: (request: Request) => void;
    /** Whether a request carries an admin credential (bearer, `adminGate` grant, or Studio's WS ticket), which a pause never refuses. */
    isAdmin: (request: Request) => boolean | Promise<boolean>;
    /** The clock the cache window is measured on. */
    now?: () => number;
    /** The scheduler instance holding the flag, or `undefined` when the worker has none. */
    stub: () => ResolvedShard | undefined;
}

const NOT_PAUSED: DeploymentPauseState = { paused: false };

interface DeploymentPause {
    /** Serve `GET` / `POST /_lunora/admin/pause`. */
    handleRoute: (request: Request) => Promise<Response>;
    /** The flag as this isolate currently trusts it. */
    read: () => Promise<DeploymentPauseState>;
    /** The `503` a non-admin function call gets while paused, or `undefined`. */
    refusal: (request: Request) => Promise<Response | undefined>;
}

const createDeploymentPause = (options: DeploymentPauseOptions): DeploymentPause => {
    const now = options.now ?? Date.now;
    let cached: { readAt: number; state: DeploymentPauseState } | undefined;

    const fetchState = async (stub: ResolvedShard, init?: RequestInit): Promise<DeploymentPauseState> => {
        const response = await stub.fetch(new Request("https://scheduler.internal/pause", init));

        if (!response.ok) {
            throw new LunoraError(`SchedulerDO /pause answered ${String(response.status)}: ${await response.text()}`, { code: "INTERNAL", status: 502 });
        }

        const state: DeploymentPauseState = await response.json();

        cached = { readAt: now(), state };

        return state;
    };

    /**
     * The flag as this isolate last saw it, re-read once the cache window lapses.
     * Fails open: when the scheduler cannot be reached the deployment is treated
     * as running, because a scheduler outage that took every function down with
     * it is the worse failure. The failed read is cached too, so an outage costs
     * one attempt per window rather than one per request.
     */
    const read = async (): Promise<DeploymentPauseState> => {
        const stub = options.stub();

        if (stub === undefined) {
            return NOT_PAUSED;
        }

        if (cached !== undefined && now() - cached.readAt < PAUSE_CACHE_MS) {
            return cached.state;
        }

        try {
            return await fetchState(stub);
        } catch {
            cached = { readAt: now(), state: NOT_PAUSED };

            return NOT_PAUSED;
        }
    };

    /** The `503` a function call gets while paused, or `undefined` to let it through. */
    const refusal = async (request: Request): Promise<Response | undefined> => {
        const state = await read();

        // The flag first: `isAdmin` may run the async `adminGate`, which only a
        // paused deployment should pay for on the function-call path.
        if (!state.paused || (await options.isAdmin(request))) {
            return undefined;
        }

        const message = state.reason === undefined ? "the deployment is paused" : `the deployment is paused: ${state.reason}`;

        return Response.json(
            { error: { code: "DEPLOYMENT_PAUSED", message } },
            { headers: { "cache-control": "no-store", "retry-after": String(PAUSED_RETRY_AFTER_SECONDS) }, status: 503 },
        );
    };

    /**
     * `GET /_lunora/admin/pause` reads the flag (always fresh, never the cache);
     * `POST { paused, reason? }` sets it. `supported: false` on a worker without
     * a scheduler, so a UI can hide the switch instead of offering one that fails.
     */
    const handleRoute = async (request: Request): Promise<Response> => {
        options.assertAdmin(request);

        const stub = options.stub();

        if (request.method === "GET") {
            return Response.json(stub === undefined ? { ...NOT_PAUSED, supported: false } : { ...(await fetchState(stub)), supported: true });
        }

        assertMethod(request, "POST", "Deployment pause");

        if (stub === undefined) {
            throw new LunoraError("pausing a deployment requires a `schedulerDO` namespace on the worker", { code: "PAUSE_NOT_CONFIGURED", status: 400 });
        }

        const body = (await request.json().catch(() => undefined)) as { paused?: unknown; reason?: unknown } | undefined;

        if (typeof body?.paused !== "boolean") {
            throw new LunoraError("Deployment pause requires a boolean `paused`", { code: "BAD_REQUEST", status: 400 });
        }

        const state = await fetchState(stub, {
            body: JSON.stringify({ paused: body.paused, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        return Response.json({ ...state, supported: true });
    };

    return { handleRoute, read, refusal };
};

/**
 * Hold a paused queue batch: every message goes back with a delay, which costs
 * it one delivery attempt — so a pause longer than the consumer's
 * `max_retries` × this delay dead-letters what it held. Long enough that the
 * default three retries ride out a quarter hour, short enough that a resume
 * drains within minutes.
 */
// ponytail: re-enqueueing with a fresh budget (the `@lunora/queue` requeue envelope) is the upgrade if pauses outlast that.
const PAUSED_QUEUE_RETRY_SECONDS = 300;

/** Retry every message of `batch` for later, when the batch exposes `retryAll`. Answers whether it did. */
const holdQueueBatch = (batch: unknown): boolean => {
    const retryAll = (batch as { retryAll?: unknown } | null)?.retryAll;

    if (typeof retryAll !== "function") {
        return false;
    }

    (retryAll as (options: { delaySeconds: number }) => void).call(batch, { delaySeconds: PAUSED_QUEUE_RETRY_SECONDS });

    return true;
};

export type { DeploymentPause, DeploymentPauseState };
export { createDeploymentPause, holdQueueBatch, PAUSE_CACHE_MS, PAUSE_PATH, PAUSED_QUEUE_RETRY_SECONDS };
