/**
 * The `/_lunora/admin/scheduled*` route cluster, extracted from `create-worker.ts`
 * (mirrors `./auth-admin-routes`). These back the studio's scheduled-jobs view:
 * list the pending jobs, read the SchedulerDO workpool status (the SLO view's
 * per-pool `{ queued, inFlight, maxConcurrency }` + app-wide totals), list the
 * dead-letter records, subscribe to the live job list over a WebSocket, and
 * cancel / retry / purge a job by id. Each one proxies a single SchedulerDO
 * route on the resolved scheduler instance.
 *
 * Every handler is closure-free of the worker's internals — it reaches the
 * admin-token gate, the scheduler-namespace requirement, and the resolved stub
 * through the injected {@link ScheduledAdminRouteDeps}, so this module imports no
 * runtime values from `create-worker`.
 */
import { LunoraError } from "./errors";
import type { ResolvedShard, ShardNamespaceLike } from "./resolve-shard";
import { resolveShard } from "./resolve-shard";

const SCHEDULED_PATH = "/_lunora/admin/scheduled";
const SCHEDULED_STATUS_PATH = "/_lunora/admin/scheduled/status";
const SCHEDULED_WS_PATH = "/_lunora/admin/scheduled/ws";
const SCHEDULED_CANCEL_PATH = "/_lunora/admin/scheduled/cancel";
const SCHEDULED_DEAD_PATH = "/_lunora/admin/scheduled/dead";
const SCHEDULED_DEAD_RETRY_PATH = "/_lunora/admin/scheduled/dead/retry";
const SCHEDULED_DEAD_CANCEL_PATH = "/_lunora/admin/scheduled/dead/cancel";
const SCHEDULED_POOL_RELEASE_PATH = "/_lunora/admin/scheduled/pool/release";

/** The worker internals the scheduled routes reach through injection rather than closure. */
interface ScheduledAdminRouteDeps {
    /** Accept the admin credential from either the `Authorization` header or the `?token=` WS query param — the master token or an ephemeral minted sub-token (resolves `true` when authorized). Async because the sub-token verify is WebCrypto HMAC. */
    checkWsAdmin: (request: Request) => Promise<boolean>;
    /** Require a configured `schedulerDO` namespace, else throw `SCHEDULER_NOT_CONFIGURED`. */
    requireSchedulerNamespace: () => ShardNamespaceLike;
    /** Admin-gate the request, then resolve the scheduler-instance stub. */
    resolveSchedulerStub: (request: Request) => ResolvedShard;
    /** The scheduler-instance name to address (off `WorkerOptions`, defaulting to `"default"`). */
    schedulerInstanceName: string;
}

/** Build the `/_lunora/admin/scheduled*` route map merged into the worker's internal route table. */
const buildScheduledAdminRoutes = (deps: ScheduledAdminRouteDeps): Record<string, (request: Request) => Promise<Response> | Response> => {
    const { checkWsAdmin, requireSchedulerNamespace, resolveSchedulerStub, schedulerInstanceName } = deps;

    /** Admin-gated GET proxy to one SchedulerDO route; `label` names the endpoint in the 405. */
    const proxyGet =
        (doPath: string, label: string) =>
        (request: Request): Promise<Response> => {
            if (request.method !== "GET") {
                throw new LunoraError(`${label} endpoint requires GET`, { code: "METHOD_NOT_ALLOWED", status: 405 });
            }

            // Forward the page cursor: `/list` and `/dead` answer one bounded page
            // plus a `cursor`, so without this the studio could never see past
            // the first page of a large backlog or dead-letter set.
            const cursor = new URL(request.url).searchParams.get("cursor");
            const query = cursor === null || cursor === "" ? "" : `?cursor=${encodeURIComponent(cursor)}`;

            return resolveSchedulerStub(request).fetch(new Request(`https://scheduler.internal${doPath}${query}`, { method: "GET" }));
        };

    /**
     * Admin-gated `POST { id }` proxy to one SchedulerDO route — the shared
     * shape of cancel (`/cancel`), dead-letter retry (`/dead/retry`, resurrect a
     * job that exhausted its retry budget), and dead-letter cancel
     * (`/dead/cancel`, purge it). `label` names the endpoint in the id-missing
     * 400; `endpointLabel` (defaulting to it) names it in the 405.
     */
    const proxyPost =
        (doPath: string, label: string, endpointLabel: string = label) =>
        async (request: Request): Promise<Response> => {
            if (request.method !== "POST") {
                throw new LunoraError(`${endpointLabel} requires POST`, { code: "METHOD_NOT_ALLOWED", status: 405 });
            }

            const stub = resolveSchedulerStub(request);
            const body = (await request.json().catch(() => undefined)) as { id?: unknown } | undefined;

            if (typeof body?.id !== "string" || body.id === "") {
                throw new LunoraError(`${label} requires a string \`id\``, { code: "BAD_REQUEST", status: 400 });
            }

            return stub.fetch(
                new Request(`https://scheduler.internal${doPath}`, {
                    body: JSON.stringify({ id: body.id }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );
        };

    /**
     * `POST /pool/release { pool, id? }` — release one held workpool concurrency
     * slot, by proxying the SchedulerDO's `/complete`.
     *
     * This is the ONLY shipped way to undo a leaked slot. `releasePoolSlot` in
     * `create-worker` is best-effort by design (a release failure must not fail
     * the dispatch the scheduler awaits), there is no lease and nothing
     * reconciles, so a dispatch that succeeds followed by a failed release —
     * an isolate evicted at the invocation boundary, a 500, a rotated binding —
     * holds that slot for the lifetime of the pool. At the default
     * `maxConcurrency: 1` that wedges the pool permanently while every queued job
     * re-arms the alarm once a second and never runs. `/status` diagnoses it
     * exactly (`inFlight` pinned with a growing `backlog`) and, before this
     * route, offered no way out.
     *
     * `id` is OPTIONAL on purpose: `/status` reports slot counts, not the ids
     * holding them, so an operator staring at a wedged pool usually cannot name
     * the leaked job. Omitting it takes the DO's best-effort "drop one held slot"
     * path, which is precisely the recovery wanted here.
     */
    const handlePoolRelease = async (request: Request): Promise<Response> => {
        if (request.method !== "POST") {
            throw new LunoraError("Scheduled pool-release endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);
        const body = (await request.json().catch(() => undefined)) as { id?: unknown; pool?: unknown } | undefined;

        if (typeof body?.pool !== "string" || body.pool === "") {
            throw new LunoraError("Scheduled pool-release requires a string `pool`", { code: "BAD_REQUEST", status: 400 });
        }

        const id = typeof body.id === "string" && body.id !== "" ? body.id : undefined;

        return stub.fetch(
            new Request("https://scheduler.internal/complete", {
                body: JSON.stringify(id === undefined ? { pool: body.pool } : { id, pool: body.pool }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    };

    /**
     * Proxy a browser WebSocket upgrade to the SchedulerDO's `/ws` so the
     * studio can subscribe to the live job list. A browser `WebSocket` can't
     * set an `Authorization` header, so the admin credential is also accepted
     * via the `?token=` query parameter — the only channel the constructor
     * allows. The gate takes the master token or an ephemeral minted sub-token
     * (`POST /_lunora/admin/ws-token`), so the master credential can stay out
     * of the URL.
     */
    const handleScheduledWebSocket = async (request: Request): Promise<Response> => {
        if (request.headers.get("Upgrade") !== "websocket") {
            throw new LunoraError("WebSocket upgrade header missing", { code: "BAD_REQUEST", status: 426 });
        }

        if (!(await checkWsAdmin(request))) {
            throw new LunoraError("admin authorization required", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const namespace = requireSchedulerNamespace();
        const stub = resolveShard(namespace, schedulerInstanceName);

        return stub.fetch(new Request("https://scheduler.internal/ws", { headers: { Upgrade: "websocket" } }));
    };

    return {
        [SCHEDULED_CANCEL_PATH]: proxyPost("/cancel", "Scheduled-cancel", "Scheduled-cancel endpoint"),
        [SCHEDULED_DEAD_CANCEL_PATH]: proxyPost("/dead/cancel", "Scheduled dead-letter action"),
        [SCHEDULED_DEAD_PATH]: proxyGet("/dead", "Scheduled dead-letter"),
        [SCHEDULED_DEAD_RETRY_PATH]: proxyPost("/dead/retry", "Scheduled dead-letter action"),
        [SCHEDULED_PATH]: proxyGet("/list", "Scheduled-list"),
        [SCHEDULED_POOL_RELEASE_PATH]: handlePoolRelease,
        [SCHEDULED_STATUS_PATH]: proxyGet("/status", "Scheduler-status"),
        [SCHEDULED_WS_PATH]: handleScheduledWebSocket,
    };
};

export type { ScheduledAdminRouteDeps };
export {
    buildScheduledAdminRoutes,
    SCHEDULED_CANCEL_PATH,
    SCHEDULED_DEAD_CANCEL_PATH,
    SCHEDULED_DEAD_PATH,
    SCHEDULED_DEAD_RETRY_PATH,
    SCHEDULED_PATH,
    SCHEDULED_POOL_RELEASE_PATH,
    SCHEDULED_STATUS_PATH,
    SCHEDULED_WS_PATH,
};
