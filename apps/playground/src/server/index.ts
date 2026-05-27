import type { CirrusAuth } from "@cirrus/auth";
import { createAuth, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import type { ExecutionContextLike, Route, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

export { SchedulerDO } from "./SchedulerDO.js";
export { ShardDO } from "./ShardDO.js";

interface Env {
    AUTH_SECRET?: string;
    /** Base URL the auth handler resolves callback URLs against. */
    AUTH_URL?: string;

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
 * Worker entry — composes `@cirrus/auth` (better-auth) and `@cirrus/runtime`.
 *
 * Better-auth handles its own arbitrarily nested routes under `/api/auth/*`
 * via a single handler, which doesn't fit the runtime's exact-path router.
 * We intercept the auth prefix here, then fall through to the runtime for
 * RPC + WebSocket traffic.
 */
let worker: ReturnType<typeof createWorker> | null = null;
let auth: CirrusAuth | null = null;

const buildAuth = (env: Env): CirrusAuth => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    return createAuth({
        baseURL: env.AUTH_URL,
        database: env.DB as never,
        emailAndPassword: { enabled: true },
        secret: env.AUTH_SECRET,
    });
};

const buildWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        d1: env.DB,
        // The runtime's route map can stay empty: better-auth routes are
        // dispatched ahead of the worker by the `handleAuthRequest` hook.
        routes: {} as Record<string, Route>,
        shardDO: env.SHARD,
    });

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

    if (url.pathname === "/test/reset" && request.method === "POST") {
        try {
            const id = env.SHARD.idFromName("__e2e_reset__");
            const stub = env.SHARD.get(id);

            await stub.fetch(new Request("https://do/internal/reset", { method: "POST" }));
        } catch {
            // best-effort
        }

        return Response.json({ ok: true });
    }

    if (url.pathname === "/test/sign" && request.method === "POST") {
        return Response.json({ url: null, error: "not implemented in playground build" }, { status: 501 });
    }

    if (url.pathname === "/test/schedule" && request.method === "POST") {
        return Response.json({ jobId: null, error: "not implemented in playground build" }, { status: 501 });
    }

    if (url.pathname === "/test/job-status" && request.method === "GET") {
        return Response.json({ status: "unknown" });
    }

    if (url.pathname === "/test/throw" && request.method === "POST") {
        return Response.json({ error: "simulated" }, { status: 500 });
    }

    return new Response("not found", { status: 404 });
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        const testResponse = await handleTestRoute(request, env);

        if (testResponse) {
            return testResponse;
        }

        if (!auth) {
            auth = buildAuth(env);

            // Apply the better-auth schema lazily on first request. For
            // production workloads, run `pnpm --filter playground migrate`
            // ahead of deploy so the first user request doesn't pay the diff
            // cost.
            await ensureMigrated(auth);
        }

        const authResponse = await handleAuthRequest(auth, request);

        if (authResponse) {
            return authResponse;
        }

        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
};
