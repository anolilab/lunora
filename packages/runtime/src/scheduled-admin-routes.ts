/**
 * The `/_lunora/admin/scheduled*` route cluster, extracted from `create-worker.ts`
 * (mirrors `./auth-admin-routes`). These back the studio's scheduled-jobs view:
 * list the pending jobs, read the SchedulerDO workpool status, subscribe to the
 * live job list over a WebSocket, and cancel a job by id. Each one proxies a
 * single SchedulerDO route on the resolved scheduler instance.
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

    const handleScheduledList = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new LunoraError("Scheduled-list endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);

        return stub.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));
    };

    /**
     * Proxy the SchedulerDO's `GET /status` so the studio can read the
     * app-level workpool backlog (per-pool `{ queued, inFlight, maxConcurrency }`
     * plus app-wide `backlog`/`inFlight` totals) that powers the SLO view. A
     * sibling of {@link handleScheduledList}: same admin gate + scheduler-instance
     * resolution via `resolveSchedulerStub`, just a different DO route.
     */
    const handleSchedulerStatus = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new LunoraError("Scheduler-status endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);

        return stub.fetch(new Request("https://scheduler.internal/status", { method: "GET" }));
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

    const handleScheduledCancel = async (request: Request): Promise<Response> => {
        if (request.method !== "POST") {
            throw new LunoraError("Scheduled-cancel endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);
        const body = (await request.json().catch(() => undefined)) as { id?: unknown } | undefined;

        if (typeof body?.id !== "string" || body.id === "") {
            throw new LunoraError("Scheduled-cancel requires a string `id`", { code: "BAD_REQUEST", status: 400 });
        }

        return stub.fetch(
            new Request("https://scheduler.internal/cancel", {
                body: JSON.stringify({ id: body.id }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    };

    /**
     * Proxy the SchedulerDO's `GET /dead` so the studio can list the
     * dead-letter records — jobs that exhausted their retry budget and were
     * parked instead of dropped. Same admin gate + scheduler-instance
     * resolution as {@link handleScheduledList}.
     */
    const handleDeadList = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new LunoraError("Scheduled dead-letter endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);

        return stub.fetch(new Request("https://scheduler.internal/dead", { method: "GET" }));
    };

    /**
     * Proxy `POST /dead/retry { id }` (resurrect a dead job) or
     * `POST /dead/cancel { id }` (purge it) to the matching SchedulerDO route.
     * Both share the admin gate, id validation, and instance resolution of
     * {@link handleScheduledCancel}; only the upstream path differs.
     */
    const proxyDeadAction =
        (doPath: string) =>
        async (request: Request): Promise<Response> => {
            if (request.method !== "POST") {
                throw new LunoraError("Scheduled dead-letter action requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
            }

            const stub = resolveSchedulerStub(request);
            const body = (await request.json().catch(() => undefined)) as { id?: unknown } | undefined;

            if (typeof body?.id !== "string" || body.id === "") {
                throw new LunoraError("Scheduled dead-letter action requires a string `id`", { code: "BAD_REQUEST", status: 400 });
            }

            return stub.fetch(
                new Request(`https://scheduler.internal${doPath}`, {
                    body: JSON.stringify({ id: body.id }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );
        };

    return {
        [SCHEDULED_CANCEL_PATH]: handleScheduledCancel,
        [SCHEDULED_DEAD_CANCEL_PATH]: proxyDeadAction("/dead/cancel"),
        [SCHEDULED_DEAD_PATH]: handleDeadList,
        [SCHEDULED_DEAD_RETRY_PATH]: proxyDeadAction("/dead/retry"),
        [SCHEDULED_PATH]: handleScheduledList,
        [SCHEDULED_STATUS_PATH]: handleSchedulerStatus,
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
    SCHEDULED_STATUS_PATH,
    SCHEDULED_WS_PATH,
};
