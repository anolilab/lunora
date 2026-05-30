import type { CirrusAuth } from "@cirrus/auth";
import { createAuth, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import type { D1DatabaseLike, D1Exec } from "@cirrus/d1";
import { listGlobalTables, readGlobalTablePage } from "@cirrus/d1";
import type { ExecutionContextLike, GlobalIntrospector, Route, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
import { createScheduler, type DurableObjectNamespaceLike } from "@cirrus/scheduler";
import type { R2BucketLike } from "@cirrus/storage";
import { buildSignedUrl, createStorage } from "@cirrus/storage";

import { CIRRUS_FUNCTIONS } from "../../cirrus/_generated/server.js";
import { createShardDO } from "../../cirrus/_generated/shard.js";
import schema from "../../cirrus/schema.js";

/**
 * Adapt the raw D1 binding to `@cirrus/d1`'s `D1Exec` so the dashboard's global
 * data browser can introspect `.global()` tables. Reads only — `run` is needed
 * by the shared helper signature but the introspector never writes.
 */
const d1Introspector = (db: D1DatabaseLike): GlobalIntrospector => {
    const exec: D1Exec = {
        all: async (sql, parameters) => {
            const result = await db
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        run: async (sql, parameters) => {
            await db
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };

    return {
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

export { SchedulerDO } from "./scheduler-do.js";

interface ShardEnv {
    CIRRUS_WORKER_ORIGIN?: string;
    FILES?: R2BucketLike;
    PUBLIC_STORAGE_BASE_URL?: string;
    SCHEDULER?: DurableObjectNamespaceLike;
    STORAGE_SECRET?: string;
}

export const ShardDO = createShardDO({
    scheduler: (env) => {
        const shardEnv = env as ShardEnv;

        return shardEnv.SCHEDULER && shardEnv.CIRRUS_WORKER_ORIGIN
            ? createScheduler({ namespace: shardEnv.SCHEDULER, originUrl: shardEnv.CIRRUS_WORKER_ORIGIN })
            : undefined;
    },
    storage: (env) => {
        const shardEnv = env as ShardEnv;

        return shardEnv.FILES
            ? createStorage({ bucket: shardEnv.FILES, publicBaseUrl: shardEnv.PUBLIC_STORAGE_BASE_URL, signingSecret: shardEnv.STORAGE_SECRET })
            : undefined;
    },
});

interface Env {
    AUTH_SECRET?: string;
    /** Base URL the auth handler resolves callback URLs against. */
    AUTH_URL?: string;
    /** Bearer token gating the admin export/import and scheduled-job endpoints. */
    CIRRUS_ADMIN_TOKEN?: string;

    /**
     * When set to the literal string `"true"`, the worker exposes a small
     * surface of `/test/*` helpers (reset DO state, mint a short-lived signed
     * URL, schedule a job, etc.) used by the `@cirrus/e2e` Playwright suite.
     * The flag is read in `apps/playground/wrangler.jsonc` and injected via
     * `tests/e2e/globalSetup.ts` — *never* set this in production.
     */
    CIRRUS_E2E?: string;
    DB: unknown;
    FILES: R2BucketLike;
    /** Public base URL R2 objects resolve against — used to mint signed URLs. */
    PUBLIC_STORAGE_BASE_URL?: string;
    SCHEDULER: DurableObjectNamespaceLike & ShardNamespaceLike;
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
        // When set, enables the admin-gated export/import and scheduled-job
        // endpoints the @cirrus/dashboard panels call.
        adminToken: env.CIRRUS_ADMIN_TOKEN,
        d1: env.DB,
        // Exposes /_cirrus/admin/functions so the dashboard's runner can
        // auto-discover queries/mutations/actions.
        functions: CIRRUS_FUNCTIONS,
        // Exposes /_cirrus/admin/global/* so the dashboard can browse `.global()`
        // (D1-backed) tables.
        globalIntrospector: env.DB ? d1Introspector(env.DB as D1DatabaseLike) : undefined,
        resolveIdentity: async (request) => {
            if (!auth) {
                return null;
            }

            const session = await auth.api.getSession({ headers: request.headers });

            return session?.user?.id ? { userId: session.user.id } : null;
        },
        // The runtime's route map can stay empty: better-auth routes are
        // dispatched ahead of the worker by the `handleAuthRequest` hook.
        routes: {} as Record<string, Route>,
        // Exposes /_cirrus/admin/scheduled so the dashboard can list/cancel jobs.
        schedulerDO: env.SCHEDULER,
        shardDO: env.SHARD,
        // Exposes /_cirrus/admin/storage so the dashboard's file browser can
        // page through R2 objects. Omitted when no bucket is bound.
        storageList: env.FILES ? createStorage({ bucket: env.FILES }).list : undefined,
    });

const handleTestReset = async (env: Env): Promise<Response> => {
    try {
        const id = env.SHARD.idFromName("__e2e_reset__");
        const stub = env.SHARD.get(id);

        await stub.fetch(new Request("https://do/internal/reset", { method: "POST" }));
    } catch {
        // best-effort
    }

    return Response.json({ ok: true });
};

const handleTestSign = async (request: Request, env: Env): Promise<Response> => {
    if (!env.STORAGE_SECRET || !env.PUBLIC_STORAGE_BASE_URL) {
        return Response.json({ error: "STORAGE_SECRET and PUBLIC_STORAGE_BASE_URL must both be configured", url: null }, { status: 500 });
    }

    const body = (await request.json().catch(() => null)) as { expiresInSeconds?: number; key?: string; method?: "GET" | "PUT" } | null;

    if (!body?.key) {
        return Response.json({ error: "`key` is required", url: null }, { status: 400 });
    }

    const signed = await buildSignedUrl({
        baseUrl: env.PUBLIC_STORAGE_BASE_URL,
        expiresInSeconds: body.expiresInSeconds,
        key: body.key,
        method: body.method ?? "GET",
        secret: env.STORAGE_SECRET,
    });

    return Response.json({ url: signed });
};

const handleTestSchedule = async (request: Request, env: Env): Promise<Response> => {
    const body = (await request.json().catch(() => null)) as {
        args?: Record<string, unknown>;
        delayMs?: number;
        functionPath?: string;
        scheduledFor?: number;
    } | null;

    if (!body?.functionPath) {
        return Response.json({ error: "`functionPath` is required", jobId: null }, { status: 400 });
    }

    const originUrl = new URL(request.url).origin;
    const scheduler = createScheduler({ namespace: env.SCHEDULER, originUrl });
    const scheduledFor = body.scheduledFor ?? Date.now() + (body.delayMs ?? 0);

    const result = await scheduler.runAt(scheduledFor, { __cirrusRef: body.functionPath }, body.args ?? {});

    return Response.json({ jobId: result.id, scheduledFor: result.scheduledFor });
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

    const { method } = request;

    if (url.pathname === "/test/reset" && method === "POST") {
        return handleTestReset(env);
    }

    if (url.pathname === "/test/sign" && method === "POST") {
        return handleTestSign(request, env);
    }

    if (url.pathname === "/test/schedule" && method === "POST") {
        return handleTestSchedule(request, env);
    }

    if (url.pathname === "/test/job-status" && method === "GET") {
        return Response.json({ status: "unknown" });
    }

    if (url.pathname === "/test/throw" && method === "POST") {
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
