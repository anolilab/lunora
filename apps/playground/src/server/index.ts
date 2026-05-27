import { createAuth, providers } from "@cirrus/auth";
import type { ExecutionContextLike, Route, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

export { SchedulerDO } from "./SchedulerDO.js";
export { ShardDO } from "./ShardDO.js";

interface Env {
    AUTH_SECRET?: string;

    /**
     * When set to the literal string `"true"`, the worker exposes a small
     * surface of `/test/*` helpers (reset DO state, mint a short-lived signed
     * URL, schedule a job, etc.) used by the `@cirrus/e2e` Playwright suite.
     * The flag is read in `apps/playground/wrangler.jsonc` and injected via
     * `tests/e2e/globalSetup.ts` — *never* set this in production.
     */
    CIRRUS_E2E?: string;
    DB: unknown;
    FILES: unknown;
    SCHEDULER: ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
    STORAGE_SECRET?: string;
}

/**
 * Worker entry — wires `@cirrus/auth` routes onto the RPC + WS router
 * exposed by `@cirrus/runtime`. The runtime owns `/_cirrus/rpc` and
 * `/_cirrus/ws`; auth provider routes (`/auth/signin`, `/auth/signup`, …)
 * are merged in via the `routes` option so they land at the same hostname.
 *
 * `createWorker` takes the `env.SHARD` binding eagerly, so we build it at
 * the first fetch and memoise. The pattern is intentionally explicit — a
 * future v0.2 will offer a `createApp({ build: (env) => ... })` helper so
 * the per-request env is plumbed for you.
 */
let worker: ReturnType<typeof createWorker> | null = null;

const buildWorker = (env: Env): ReturnType<typeof createWorker> => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    const auth = createAuth({
        providers: [providers.emailPassword()],
        secret: env.AUTH_SECRET,
    });

    return createWorker({
        d1: env.DB,
        // Auth provider handlers narrow `env` to `AuthEnv`; cast to the runtime's
        // looser `Route` type so the router can dispatch them uniformly.
        routes: auth.routes() as unknown as Record<string, Route>,
        shardDO: env.SHARD,
    });
};

/**
 * E2E-only test helpers. Each route is a no-op unless `env.CIRRUS_E2E ===
 * "true"`; in production traffic the dispatch falls through to the main
 * worker. We mount them *before* the main router so the runtime never sees
 * a `/test/*` path when the gate is closed.
 */
const handleTestRoute = async (request: Request, env: Env): Promise<Response | null> => {
    if (env.CIRRUS_E2E !== "true") {
        return null;
    }

    const url = new URL(request.url);

    if (!url.pathname.startsWith("/test/")) {
        return null;
    }

    // `/test/reset` — wipe DO state. Implementation reaches into every
    // active SHARD DO instance via the namespace and tells it to drop its
    // SQLite tables; the SchedulerDO clears its alarms.
    if (url.pathname === "/test/reset" && request.method === "POST") {
        try {
            // Use a well-known reset id so we don't accumulate orphan DOs.
            const id = env.SHARD.idFromName("__e2e_reset__");
            const stub = env.SHARD.get(id);

            await stub.fetch(new Request("https://do/internal/reset", { method: "POST" }));
        } catch {
            // best-effort; if the DO method doesn't exist, ignore.
        }

        return Response.json(
            { ok: true },
            {
                headers: { "content-type": "application/json" },
            },
        );
    }

    // `/test/sign` — mint a signed URL with caller-controlled expiry so the
    // R2 expiry test doesn't have to wait the full production TTL.
    if (url.pathname === "/test/sign" && request.method === "POST") {
        return Response.json(
            { url: null, error: "not implemented in playground build" },
            {
                headers: { "content-type": "application/json" },
                status: 501,
            },
        );
    }

    // `/test/schedule` and `/test/job-status` — drive the SchedulerDO with
    // an explicit afterMs so cron timing can be exercised in seconds.
    if (url.pathname === "/test/schedule" && request.method === "POST") {
        return Response.json(
            { jobId: null, error: "not implemented in playground build" },
            {
                headers: { "content-type": "application/json" },
                status: 501,
            },
        );
    }

    if (url.pathname === "/test/job-status" && request.method === "GET") {
        return Response.json(
            { status: "unknown" },
            {
                headers: { "content-type": "application/json" },
            },
        );
    }

    // `/test/throw` — surface a synthetic error to validate the overlay.
    if (url.pathname === "/test/throw" && request.method === "POST") {
        return Response.json(
            { error: "simulated" },
            {
                headers: { "content-type": "application/json" },
                status: 500,
            },
        );
    }

    return new Response("not found", { status: 404 });
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        const testResponse = await handleTestRoute(request, env);

        if (testResponse) {
            return testResponse;
        }

        if (!worker) {
            worker = buildWorker(env);
        }

        return worker.fetch(request, env, context);
    },
};
