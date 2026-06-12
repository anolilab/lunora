import type { CirrusAuth, CirrusAuthOptions } from "@cirrus/auth";
import { cirrusD1Adapter, createAuth, createAuthAdmin, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import { admin, organization, passkey, twoFactor } from "@cirrus/auth/plugins";
import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@cirrus/d1";
import { createD1CtxDb, listGlobalTables, readGlobalTablePage } from "@cirrus/d1";
import { createMailerFromEnv } from "@cirrus/mail";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
import type { DurableObjectNamespaceLike } from "@cirrus/scheduler";
import { createScheduler } from "@cirrus/scheduler";
import type { R2BucketLike } from "@cirrus/storage";
import { buildSignedUrl, createStorage, verifySignedUrl } from "@cirrus/storage";

import { CIRRUS_CRONS } from "../../cirrus/_generated/crons.js";
import { CIRRUS_FUNCTIONS } from "../../cirrus/_generated/functions.js";
import { openApiSpec } from "../../cirrus/_generated/openapi.js";
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
    /** D1 binding backing `.global()` tables — wired into the DO so generic `ctx.db` writes to a global table route to it. */
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
    /** Origin the SchedulerDO dispatches HTTP callbacks back to (job execution). */
    CIRRUS_WORKER_ORIGIN?: string;
    DB: unknown;
    FILES: R2BucketLike;
    /** Sender address for auth (verification / reset) email; captured into the studio Mail tab in dev. */
    MAIL_FROM?: string;
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
        emailAndPassword: {
            enabled: true,
            // Forgot-password mail routes through @cirrus/mail; in dev (and the
            // E2E run) it's captured into the studio's Mail tab — see mail-reset.spec.ts.
            sendResetPassword: async ({ url, user }) => {
                await createMailerFromEnv(env as unknown as Record<string, unknown>).send({
                    subject: "Reset your password",
                    text: `Reset your password:\n${url}`,
                    to: user.email,
                });
            },
        },
        plugins: [admin({ defaultRole: "user" }), organization({ allowUserToCreateOrganization: true }), twoFactor(), passkey()],
        secret: env.AUTH_SECRET,
    };
};

/**
 * The runtime auth instance, backed by `@cirrus/auth`'s SQL adapter over D1.
 * `cirrusD1Adapter` wires the adapter explicitly rather than passing the raw
 * `env.DB`, so the better-auth Kysely dynamic-import doesn't hang the embedded
 * worker under `@cloudflare/vite-plugin` (see its doc comment). Table creation
 * stays on the Kysely migration path ({@link migrateAuth}).
 */
const buildAuth = (env: Env): CirrusAuth =>
    createAuth({
        ...authOptions(env),
        database: cirrusD1Adapter(env.DB as never),
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
        // The generated OpenAPI document (regenerated on every `cirrus/` change)
        // backs the studio's always-current API-reference tab.
        openApiSpec,
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

/** The slice of D1 the reset needs: list tables, then empty them. */
interface D1Reset {
    prepare: (sql: string) => {
        all: () => Promise<{ results: { name: string }[] }>;
        run: () => Promise<unknown>;
    };
}

/**
 * Clear D1 between tests: empty every user table (auth `user`/`session`/… plus
 * app tables) so each spec starts from a known-empty database. We DELETE rather
 * than DROP so the schema survives and no re-migration is needed, and we delete
 * in reverse creation order (children before parents) so foreign-key references
 * don't block the clear.
 */
const clearD1 = async (database: D1Reset): Promise<void> => {
    const { results } = await database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")
        .all();

    // Children-before-parents (reverse creation order) so FK references don't
    // block the clear. A plain reverse for-loop — `toReversed()` isn't in the
    // Node-16 target and `[...].reverse()` trips the lint.
    for (let index = results.length - 1; index >= 0; index -= 1) {
        const { name } = results[index];

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential DELETEs; the table set is tiny
            await database.prepare(`DELETE FROM "${name}"`).run();
        } catch {
            // A FK-blocked table clears on the next pass; best-effort per table.
        }
    }
};

const handleTestReset = async (env: Env): Promise<Response> => {
    try {
        const id = env.SHARD.idFromName("__e2e_reset__");
        const stub = env.SHARD.get(id);

        await stub.fetch(new Request("https://do/internal/reset", { method: "POST" }));
    } catch {
        // best-effort
    }

    try {
        await clearD1(env.DB as D1Reset);
    } catch {
        // best-effort — a fresh DB (pre-migration) has no tables to clear
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
        const id = url.searchParams.get("id");

        if (!id || !env.SCHEDULER || !env.CIRRUS_WORKER_ORIGIN) {
            return Response.json({ status: "unknown" });
        }

        const scheduler = createScheduler({ namespace: env.SCHEDULER, originUrl: env.CIRRUS_WORKER_ORIGIN });
        const record = await scheduler.get(id);

        // The SchedulerDO deletes a job's rows once it completes successfully, so
        // a previously-scheduled id with no record left has executed.
        return Response.json({ status: record ? "scheduled" : "executed" });
    }

    return new Response("not found", { status: 404 });
};

/**
 * Serve `@cirrus/storage` signed URLs. The signer mints a URL under
 * `PUBLIC_STORAGE_BASE_URL` carrying the object key plus expiry/method/signature
 * query params; in production that base is a CDN/Worker route, but in dev the
 * Worker shares its origin, so the signed URL lands back here. We verify the
 * HMAC + expiry, then stream the R2 body (GET) or store the uploaded bytes
 * (PUT). The `avatars/` prefix is the only key namespace
 * the playground signs, and it can't collide with the `/_cirrus`, `/api/auth`,
 * `/test` routes the Worker otherwise owns.
 */
const handleStorageAsset = async (request: Request, env: Env): Promise<null | Response> => {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/avatars/")) {
        return null;
    }

    if (!env.STORAGE_SECRET || !env.FILES) {
        return new Response("storage not configured", { status: 500 });
    }

    // The signed `method` is HMAC-bound, so a GET URL can't be replayed as a PUT;
    // still require the request verb to match what was signed.
    if (request.method !== (url.searchParams.get("method") ?? "GET")) {
        return new Response("method not allowed", { status: 405 });
    }

    const verdict = await verifySignedUrl(request.url, env.STORAGE_SECRET);

    if (!verdict.valid) {
        // Opaque 403 — never leak expired-vs-bad-signature (a signing oracle).
        return new Response("forbidden", { status: 403 });
    }

    const key = decodeURIComponent(url.pathname.slice(1));

    if (request.method === "PUT") {
        await env.FILES.put(key, request.body, { httpMetadata: { contentType: request.headers.get("content-type") ?? undefined } });

        return new Response(null, { status: 200 });
    }

    const object = await env.FILES.get(key);

    if (!object) {
        return new Response("not found", { status: 404 });
    }

    return new Response(object.body, {
        headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
};

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        const testResponse = await handleTestRoute(request, env);

        if (testResponse) {
            return testResponse;
        }

        const assetResponse = await handleStorageAsset(request, env);

        if (assetResponse) {
            return assetResponse;
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
