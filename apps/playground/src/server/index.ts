import type { CirrusAuth, CirrusAuthOptions } from "@cirrus/auth";
import { cirrusAuthAdapter, createAuth, createAuthAdmin, createSqlAuthStore, d1Executor, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import { admin, organization, passkey, twoFactor } from "@cirrus/auth/plugins";
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@cirrus/d1";
import { createD1CtxDb, listGlobalTables, readGlobalTablePage } from "@cirrus/d1";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
import type { DurableObjectNamespaceLike } from "@cirrus/scheduler";
import { createScheduler } from "@cirrus/scheduler";
import type { R2BucketLike } from "@cirrus/storage";
import { buildSignedUrl, createStorage } from "@cirrus/storage";

import { CIRRUS_CRONS } from "../../cirrus/_generated/crons.js";
import { CIRRUS_FUNCTIONS } from "../../cirrus/_generated/functions.js";
import { createShardDO } from "../../cirrus/_generated/shard.js";
import schema from "../../cirrus/schema.js";

/** Adapt the raw D1 binding to `@cirrus/d1`'s `D1Exec`. Reads go through `all`; admin browsing never writes. */
const buildExec = (database: D1DatabaseLike): D1Exec => {
    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
};

/**
 * Introspect `.global()` (D1-backed) tables so the studio's global data
 * browser can list and page them.
 */
const d1Introspector = (database: D1DatabaseLike): GlobalIntrospector => {
    const exec = buildExec(database);

    return {
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

export { SchedulerDO } from "./scheduler-do.js";

interface ShardEnv {
    CIRRUS_WORKER_ORIGIN?: string;
    /** D1 binding backing `.global()` tables — wired into the DO so generic `ctx.db.<globalTable>` writes route to it. */
    DB?: D1DatabaseLike;
    FILES?: R2BucketLike;
    PUBLIC_STORAGE_BASE_URL?: string;
    SCHEDULER?: DurableObjectNamespaceLike;
    STORAGE_SECRET?: string;
}

export const ShardDO = createShardDO({
    // Back `.global()` tables with D1: the DO routes generic `ctx.db.insert("channels", …)`
    // / `query` / `get` on a global table through this writer (and the per-table
    // `ctx.db.<global>` facade shares it), so global reads/writes land in D1 — not the
    // DO's local SQLite. The D1 ctx-db auto-provisions the tables on first use.
    d1: (env) => {
        const shardEnv = env as ShardEnv;

        return shardEnv.DB ? createD1CtxDb({ exec: buildExec(shardEnv.DB), schema: schema as unknown as D1CtxDbOptions["schema"] }) : undefined;
    },
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
 * We hand the bound `handleAuthRequest` to the runtime as its `authHandler`,
 * so the worker dispatches the auth prefix itself — and instruments auth
 * attempts/failures for the app-level auth-failure SLO — before falling
 * through to the runtime for RPC + WebSocket traffic.
 */
let worker: ReturnType<typeof createWorker> | null = null;
let auth: CirrusAuth | null = null;

/**
 * Auth config shared by the runtime instance and the migration instance — same
 * plugins/secret so both describe the identical schema. The full plugin set is
 * what the studio's auth dashboard adapts to (capability-detected by
 * `createAuthAdmin`): `admin` → user management; `organization` → the
 * Organizations section; `twoFactor` → 2FA disable; `passkey` → passkey list.
 */
const authOptions = (env: Env): CirrusAuthOptions => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    return {
        baseURL: env.AUTH_URL,
        emailAndPassword: { enabled: true },
        plugins: [admin({ defaultRole: "user" }), organization({ allowUserToCreateOrganization: true }), twoFactor(), passkey()],
        secret: env.AUTH_SECRET,
    };
};

/**
 * The runtime auth instance, backed by `@cirrus/auth`'s SQL adapter over D1.
 *
 * We deliberately do NOT pass the raw `env.DB` (a D1 binding) as `database`:
 * better-auth would then resolve its Kysely adapter via a runtime
 * `await import("better-auth/adapters/kysely-adapter")` inside `auth.$context`,
 * and that dynamic import never settles under `@cloudflare/vite-plugin`'s worker
 * module runner — hanging every auth request in dev. Passing an explicit adapter
 * makes better-auth use it directly and skip that import entirely, so `pnpm dev`
 * (embedded worker) and a deployed worker behave the same. The SQL store issues
 * no DDL; table creation stays on the Kysely migration path ({@link migrateAuth}).
 */
const buildAuth = (env: Env): CirrusAuth =>
    createAuth({
        ...authOptions(env),
        database: cirrusAuthAdapter(createSqlAuthStore(d1Executor(env.DB as never))),
    });

/**
 * A throwaway instance wired to the raw D1 binding, used ONLY to drive
 * `ensureMigrated` — which compiles + applies the schema via better-auth's
 * Kysely migrator (the path that creates the tables the SQL adapter then reads
 * and writes). Its `$context` is never touched, so the dynamic-import hang above
 * never applies here.
 */
const migrateAuth = (env: Env): CirrusAuth => createAuth({ ...authOptions(env), database: env.DB as never });

const buildWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        // When set, enables the admin-gated export/import and scheduled-job
        // endpoints the @cirrus/studio panels call.
        adminToken: env.CIRRUS_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes INSIDE the worker (rather
        // than ahead of it) so the runtime instruments auth attempts/failures
        // for the app-level auth-failure SLO. Lazy like `resolveIdentity`: the
        // module-level `auth` is built on the first request before `worker.fetch`.
        // The default `authBasePath` (`/api/auth`) matches `handleAuthRequest`,
        // so it's omitted.
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Exposes /_cirrus/admin/auth/* so the studio's user dashboard can browse
        // and manage users (create/ban/role/revoke/impersonate/delete). Built from
        // the same lazy `auth` the `authHandler` uses — non-null here since the
        // fetch entry builds `auth` before `buildWorker`.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        // Code-first crons: the worker's `scheduled()` entry dispatches every job
        // declared in `cirrus/crons.ts` (compiled into the generated CIRRUS_CRONS
        // map) on its firing trigger. Empty until a `crons.ts` is added.
        cronJobs: CIRRUS_CRONS,
        d1: env.DB,
        // Exposes /_cirrus/admin/functions so the studio's runner can
        // auto-discover queries/mutations/actions. `FunctionRegistryLike` accepts
        // the generated registry directly (the endpoint omits `stream` entries).
        functions: CIRRUS_FUNCTIONS,
        // Exposes /_cirrus/admin/global/* so the studio can browse `.global()`
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
        // dispatched inside the worker via the `authHandler` option above.
        routes: {},
        // Exposes /_cirrus/admin/scheduled so the studio can list/cancel jobs.
        schedulerDO: env.SCHEDULER,
        shardDO: env.SHARD,
        // Exposes /_cirrus/admin/storage so the studio's file browser can
        // page through R2 objects, delete, and upload. Omitted when no bucket is
        // bound. The signed-URL action additionally needs a public base URL +
        // signing secret, so it's wired only when both are configured.
        ...(env.FILES
            ? (() => {
                  const storage = createStorage({ bucket: env.FILES, publicBaseUrl: env.PUBLIC_STORAGE_BASE_URL, signingSecret: env.STORAGE_SECRET });

                  return {
                      storageDelete: storage.delete,
                      storageList: storage.list,
                      storageSignedUrl:
                          env.PUBLIC_STORAGE_BASE_URL && env.STORAGE_SECRET
                              ? (key: string, urlOptions?: { expiresInSeconds?: number }) =>
                                    storage.getSignedUrl(key, { expiresInSeconds: urlOptions?.expiresInSeconds })
                              : undefined,
                      storageUpload: (key: string, body: ArrayBuffer, options?: { contentType?: string }) => storage.upload(key, body, options),
                  };
              })()
            : {}),
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

            // Apply the better-auth schema lazily on first request, via the raw-D1
            // (Kysely) migrator — the runtime `auth` uses the SQL adapter, which
            // issues no DDL. For production, run `pnpm --filter playground migrate`
            // ahead of deploy so the first user request doesn't pay the diff cost.
            await ensureMigrated(migrateAuth(env));
        }

        // `auth` is now built, so both the worker's `authHandler` and
        // `resolveIdentity` closures see it. The worker owns auth dispatch
        // (and its instrumentation) from here.
        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    // Cron Triggers (wrangler `triggers.crons`) land here. The runtime
    // dispatches them to any registered `crons` handlers and runs the built-in
    // R2 backup when the firing expression matches `backupCron` — see
    // `@cirrus/runtime`'s "Scheduled backups". Enabling the backup additionally
    // needs a `queryCoordinator` + `backupStore` on `buildWorker`.
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        await worker.scheduled(controller, env, context);
    },
};
