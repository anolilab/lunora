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
 * subscriptions until it reconnects (writes go over HTTP and are refused); HTTP
 * actions and SSR behind `httpRouter`, and custom `routes` handlers, are not gated; the built-in scheduled
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

/**
 * How long a caller waits on a flag read before it stops waiting. A read belongs
 * to the request that started it; if that request is cancelled or its context
 * ends first, the read may never settle, and every caller sharing it would hang.
 */
const PAUSE_READ_DEADLINE_MS = 3000;

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
    /** The named scheduler instance, or `undefined` when the worker has none. */
    instanceStub?: (name: string) => ResolvedShard | undefined;
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

/** Instances written to at once, so a deployment with many tenants does not open them all together. */
const FAN_OUT_BATCH = 10;

/**
 * Apply a pause or resume to every named scheduler instance registered with the
 * primary one. Answers the names it could not reach; listing them failing is
 * reported as a failure of its own, never as an empty list. Idempotent, so
 * repeating the call converges.
 */
const fanOut = async (primary: ResolvedShard, instanceStub: (name: string) => ResolvedShard | undefined, init: RequestInit): Promise<string[]> => {
    let names: string[];

    try {
        const response = await primary.fetch(new Request("https://scheduler.internal/instances"));

        if (!response.ok) {
            throw new Error(`answered ${String(response.status)}`);
        }

        const listed: { instances?: string[] } = await response.json();

        names = listed.instances ?? [];
    } catch (error) {
        return [`(the instance list: ${error instanceof Error ? error.message : String(error)})`];
    }

    const failed: string[] = [];

    for (let start = 0; start < names.length; start += FAN_OUT_BATCH) {
        // eslint-disable-next-line no-await-in-loop -- bounded batches: the next starts when this one is done
        await Promise.all(
            names.slice(start, start + FAN_OUT_BATCH).map(async (name) => {
                try {
                    const stub = instanceStub(name);
                    const response = await stub?.fetch(new Request("https://scheduler.internal/pause", init));

                    if (!response?.ok) {
                        failed.push(name);
                    }
                } catch {
                    failed.push(name);
                }
            }),
        );
    }

    return failed.toSorted((left, right) => left.localeCompare(right));
};

/** `promise`, or what `onDeadline` answers once {@link PAUSE_READ_DEADLINE_MS} passes first. */
const withDeadline = async (promise: Promise<DeploymentPauseState>, onDeadline: () => DeploymentPauseState): Promise<DeploymentPauseState> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<DeploymentPauseState>((resolve) => {
        timer = setTimeout(() => {
            resolve(onDeadline());
        }, PAUSE_READ_DEADLINE_MS);
    });

    try {
        return await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
};

const createDeploymentPause = (options: DeploymentPauseOptions): DeploymentPause => {
    const now = options.now ?? Date.now;
    let cached: { readAt: number; state: DeploymentPauseState } | undefined;
    // Shared by every caller that finds the cache stale while a read is out, so a
    // burst of calls costs one scheduler read, not one each.
    let pending: Promise<DeploymentPauseState> | undefined;
    // Bumped around every write of the flag. A read that started before a bump
    // holds a snapshot older than the write, so it must not replace the cache the
    // write just filled (the isolate that set the flag has to see it at once).
    let generation = 0;

    const fetchState = async (stub: ResolvedShard, init?: RequestInit): Promise<DeploymentPauseState> => {
        const isWrite = init?.method === "POST";
        const startedAt = generation;

        if (isWrite) {
            generation += 1;
        }

        const response = await stub.fetch(new Request("https://scheduler.internal/pause", init));

        if (!response.ok) {
            throw new LunoraError(`SchedulerDO /pause answered ${String(response.status)}: ${await response.text()}`, { code: "INTERNAL", status: 502 });
        }

        const state: DeploymentPauseState = await response.json();

        if (isWrite) {
            // Reads that began during the write may still carry the old flag.
            generation += 1;
        }

        if (isWrite || generation === startedAt) {
            cached = { readAt: now(), state };
        }

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

        const startedAt = generation;

        const shared =
            pending ??
            fetchState(stub)
                .catch(() => {
                    if (generation === startedAt) {
                        cached = { readAt: now(), state: NOT_PAUSED };
                    }

                    return NOT_PAUSED;
                })
                .finally(() => {
                    if (pending === shared) {
                        pending = undefined;
                    }
                });

        pending = shared;

        return withDeadline(shared, () => {
            // The read is abandoned: the next caller starts its own, and until then
            // the last state this isolate trusted stands (running, if it never had one).
            const fallback = cached?.state ?? NOT_PAUSED;

            if (pending === shared) {
                pending = undefined;

                if (generation === startedAt) {
                    cached = { readAt: now(), state: fallback };
                }

                // The abandoned read may still answer: with a snapshot older than any
                // read started from here on, which it must not write over.
                generation += 1;
            }

            return fallback;
        });
    };

    /** The `503` a function call gets while paused, or `undefined` to let it through. */
    const refusal = async (request: Request): Promise<Response | undefined> => {
        const state = await read();

        // The flag first: `isAdmin` may run the async `adminGate`, which only a
        // paused deployment should pay for on the function-call path.
        if (!state.paused || (await options.isAdmin(request))) {
            return undefined;
        }

        // A fixed message: the operator's `reason` is an internal note, readable on
        // the admin route only, never shown to end users.
        return Response.json(
            { error: { code: "DEPLOYMENT_PAUSED", message: "the deployment is paused" } },
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

        const init: RequestInit = {
            body: JSON.stringify({ paused: body.paused, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) }),
            headers: { "content-type": "application/json" },
            method: "POST",
        };
        // The primary first, for pause and resume alike: an instance that registers
        // after it sees the new state from the registration itself, and one that
        // registered before it is in the list read next.
        const state = await fetchState(stub, init);
        const failed = options.instanceStub === undefined ? [] : await fanOut(stub, options.instanceStub, init);

        if (failed.length > 0) {
            throw new LunoraError(
                `the deployment ${body.paused ? "paused" : "resumed"} on its main scheduler instance but not on: ${failed.join(", ")}. Run the same command again to reach them`,
                { code: "PAUSE_INSTANCES_FAILED", status: 502 },
            );
        }

        return Response.json({ ...state, supported: true });
    };

    return { handleRoute, read, refusal };
};

/**
 * How long a paused queue message is held before it is delivered again. The
 * consumer re-enqueues each message as a fresh copy for this long (see
 * `@lunora/queue`), so a pause costs no delivery attempts however long it lasts.
 * Short enough that a resume drains within minutes.
 */
const PAUSED_QUEUE_RETRY_SECONDS = 300;

export type { DeploymentPause, DeploymentPauseState };
export { createDeploymentPause, PAUSE_CACHE_MS, PAUSE_PATH, PAUSE_READ_DEADLINE_MS, PAUSED_QUEUE_RETRY_SECONDS };
