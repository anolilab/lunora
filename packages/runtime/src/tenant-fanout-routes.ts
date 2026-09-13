/**
 * The two reserved fan-out entrypoints a Workers-for-Platforms tenant depends
 * on, extracted from `create-worker.ts` (mirrors `./scheduled-admin-routes`).
 *
 * A Worker uploaded into a WfP dispatch namespace gets neither `triggers.crons`
 * nor a queue consumer of its own, so the platform drives both over HTTP
 * instead: `POST /_lunora/scheduled` replays a cron firing and `POST
 * /_lunora/queue` hands over a batch a platform-owned consumer drained. Both are
 * admin-gated, and both are the only path by which a tenant's scheduled and
 * queue work runs at all.
 *
 * Every handler is closure-free of the worker's internals — it reaches the
 * admin gate, the shared `scheduled()` dispatch, and the app's queue handler
 * through the injected {@link TenantFanoutRouteDeps}, so this module imports no
 * runtime values from `create-worker`.
 *
 * Like `./kv-admin-routes` and `./storage-admin-routes`, this module owns both
 * its paths and the body budget one of them declares, so the entry-point
 * `Content-Length` fast path and the reader that actually enforces the cap read
 * the same number from the same place.
 */
import type { ExecutionContextLike } from "../../../shared/execution-context";
import { readLooseJsonBody } from "./body-readers";
import type { QueueForwardHandler, ScheduledControllerLike } from "./create-worker";
import { LunoraError } from "./errors";

// Admin-gated HTTP entrypoint that runs a cron expression's jobs exactly as the
// native `scheduled()` trigger would. Cloudflare silently drops `triggers.crons`
// for Workers uploaded into a Workers-for-Platforms dispatch namespace, so a
// platform fans cron ticks out to its tenants by POSTing here.
const SCHEDULED_TICK_PATH = "/_lunora/scheduled";

// Admin-gated HTTP entrypoint that processes a forwarded queue batch. Namespaced
// WfP Workers can't be queue consumers, so a platform-owned consumer forwards
// batches here, where the app's `queueHandler` runs.
const QUEUE_DISPATCH_PATH = "/_lunora/queue";

/**
 * Body budget for a forwarded queue batch, declared by this route the way the KV
 * value PUT declares `KV_VALUE_MAX_BODY_BYTES`. Derived from what Cloudflare
 * Queues can hand a consumer: `max_batch_size` tops out at 100 messages and a
 * message may carry 128 KiB, so a full batch is 12.5 MiB of message bodies
 * before the forwarding envelope (`queue`, per-message `id`) and JSON string
 * escaping. 16 MiB covers that with the same ~1.3× headroom the KV cap allows
 * its 25 MiB value, and stays under the 32 MiB the KV and storage routes already
 * buffer, so it is not a new memory ceiling for the isolate.
 */
const QUEUE_DISPATCH_MAX_BODY_BYTES: number = 16 * 1_048_576;

/** The worker internals the fan-out routes reach through injection rather than closure. */
interface TenantFanoutRouteDeps {
    /** Admin-gate the request (throws `ADMIN_FORBIDDEN` when unauthorized). */
    assertAdmin: (request: Request) => void;

    /**
     * The worker's own `scheduled()` dispatch. The HTTP tick goes through the
     * SAME path the native trigger uses (user crons + code crons + scheduled
     * backup), so a replayed firing behaves identically to a real one.
     */
    dispatchScheduled: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void>;

    /** The app's forwarded-batch handler, off `WorkerOptions`. Absent when the app declares no queues. */
    queueHandler?: QueueForwardHandler;
}

/** Build the reserved fan-out route map merged into the worker's internal route table. */
const buildTenantFanoutRoutes = (
    deps: TenantFanoutRouteDeps,
): Record<string, (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response>> => {
    const { assertAdmin, dispatchScheduled, queueHandler } = deps;

    /**
     * `POST /_lunora/scheduled` — run a cron expression's jobs over HTTP, the
     * Workers-for-Platforms workaround for dropped `triggers.crons` (a platform
     * fans ticks out to its namespaced tenants). Admin-gated; the body carries
     * the cron expression to run as `{ "cron": "0 9 * * *" }`.
     */
    const handleScheduledTick = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<Response> => {
        assertAdmin(request);

        if (request.method !== "POST") {
            throw new LunoraError("scheduled tick endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        // Read under the shared byte budget, like every sibling admin route: a
        // bare `request.json()` drains whatever is sent, so a chunked body slips
        // the cap the `Content-Length` fast path only loosely enforces.
        // `| null`, not `| undefined`: the reader returns `{}` for an empty body,
        // the parsed value, or throws — so it never resolves `undefined`, but
        // `JSON.parse("null")` is a perfectly good parsed value, and reading a
        // property off it would 500 a request that deserves the 400 below.
        const body = (await readLooseJsonBody(request, "Scheduled tick")) as { cron?: unknown } | null;
        const cron = typeof body?.cron === "string" ? body.cron : "";

        if (cron === "") {
            throw new LunoraError("scheduled tick requires a `cron` expression", { code: "BAD_REQUEST", status: 400 });
        }

        await dispatchScheduled({ cron, noRetry: () => {}, scheduledTime: Date.now() }, env, context);

        return Response.json({ cron, ok: true });
    };

    /**
     * `POST /_lunora/queue` — process a forwarded queue batch (the WfP workaround
     * for queue consumers). Admin-gated; the body is
     * `{ "queue": "name", "messages": [{ "id": "...", "body": ... }] }`. Returns
     * `{ "retry": [ids] }` so the platform consumer can retry only the failures.
     */
    const handleQueueDispatch = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<Response> => {
        assertAdmin(request);

        if (request.method !== "POST") {
            throw new LunoraError("queue dispatch endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!queueHandler) {
            throw new LunoraError("no queueHandler configured", { code: "BAD_REQUEST", status: 400 });
        }

        // `| null`, not `| undefined`: see the note in the cron tick above.
        const body = (await readLooseJsonBody(request, "Queue dispatch", QUEUE_DISPATCH_MAX_BODY_BYTES)) as { messages?: unknown; queue?: unknown } | null;

        // An answer of `{"retry": []}` tells the platform consumer to ACK the
        // whole batch, so a body this route could not read must be a 400 rather
        // than a run over an empty message list: no body at all, a JSON root that
        // isn't an object, or a `messages` that isn't an array would otherwise
        // acknowledge — and discard — messages nothing ever delivered. Queues
        // never hands a consumer an empty batch, so an explicit `[]` stays legal.
        if (!Array.isArray(body?.messages)) {
            throw new LunoraError("queue dispatch requires a `messages` array", { code: "BAD_REQUEST", status: 400 });
        }

        const queue = typeof body.queue === "string" ? body.queue : "";
        const messages = body.messages
            .filter(
                (message): message is { body: unknown; id: string } =>
                    typeof message === "object" && message !== null && typeof (message as { id?: unknown }).id === "string",
            )
            .map((message) => {
                return { body: (message as { body?: unknown }).body, id: (message as { id: string }).id };
            });

        const result = await queueHandler({ messages, queue }, env, context);

        return Response.json({ retry: result?.retry ?? [] });
    };

    return {
        [QUEUE_DISPATCH_PATH]: handleQueueDispatch,
        [SCHEDULED_TICK_PATH]: handleScheduledTick,
    };
};

export type { TenantFanoutRouteDeps };
export { buildTenantFanoutRoutes, QUEUE_DISPATCH_MAX_BODY_BYTES, QUEUE_DISPATCH_PATH, SCHEDULED_TICK_PATH };
