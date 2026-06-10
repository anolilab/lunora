import type { CirrusAuth } from "@cirrus/auth";
import { cirrusD1Adapter, createAuth, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import type { ExecutionContextLike, Route, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
import { createScheduler, type DurableObjectNamespaceLike } from "@cirrus/scheduler";
import type { R2BucketLike } from "@cirrus/storage";
import { createStorage } from "@cirrus/storage";
import type { VectorizeIndexLike } from "@cirrus/vectors";

import { openApiSpec } from "../../cirrus/_generated/openapi.js";
import { createShardDO } from "../../cirrus/_generated/shard.js";

export { SchedulerDO } from "./scheduler-do.js";

interface Env {
    AUTH_SECRET?: string;
    AUTH_URL?: string;
    DB: unknown;
    FILES: unknown;
    SCHEDULER: ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
    STORAGE_SECRET?: string;
}

interface ShardEnv {
    CIRRUS_WORKER_ORIGIN?: string;
    FILES?: R2BucketLike;
    // Bound by the `[[vectorize]]` entry in wrangler.jsonc; required because the
    // schema declares the `posts_search` index.
    POSTS_SEARCH: VectorizeIndexLike;
    PUBLIC_STORAGE_BASE_URL?: string;
    SCHEDULER?: DurableObjectNamespaceLike;
    STORAGE_SECRET?: string;
}

export const ShardDO = createShardDO({
    scheduler: (env) => {
        const shardEnv = env as unknown as ShardEnv;

        return shardEnv.SCHEDULER && shardEnv.CIRRUS_WORKER_ORIGIN
            ? createScheduler({ namespace: shardEnv.SCHEDULER, originUrl: shardEnv.CIRRUS_WORKER_ORIGIN })
            : undefined;
    },
    storage: (env) => {
        const shardEnv = env as unknown as ShardEnv;

        return shardEnv.FILES
            ? createStorage({ bucket: shardEnv.FILES, publicBaseUrl: shardEnv.PUBLIC_STORAGE_BASE_URL, signingSecret: shardEnv.STORAGE_SECRET })
            : undefined;
    },
    // Maps the schema's logical index name (`posts_search`) to the Vectorize
    // binding. This is what makes `ctx.vectors` live and auto-syncs writes.
    vectors: (env) => ({ posts_search: (env as unknown as ShardEnv).POSTS_SEARCH }),
});

let worker: ReturnType<typeof createWorker> | null = null;
let auth: CirrusAuth | null = null;
let authReady: Promise<CirrusAuth> | null = null;

/**
 * Compose the full v0.1 add-on stack: better-auth for email/password sign-in
 * (`@cirrus/auth`), sharded function dispatch from `@cirrus/runtime`, and
 * D1-backed user storage.
 */
const authOptions = (env: Env): Parameters<typeof createAuth>[0] => {
    if (!env.AUTH_SECRET) {
        throw new Error("AUTH_SECRET is required");
    }

    return {
        baseURL: env.AUTH_URL,
        emailAndPassword: { enabled: true },
        secret: env.AUTH_SECRET,
    };
};

// Runtime auth via the SQL adapter — passing raw D1 makes better-auth resolve
// its Kysely adapter through a runtime `await import(...)` in `auth.$context`
// that hangs under `@cloudflare/vite-plugin`'s worker module runner (`pnpm dev`).
// An explicit adapter skips that import; dev matches a deployed worker.
const buildAuth = (env: Env): CirrusAuth => createAuth({ ...authOptions(env), database: cirrusD1Adapter(env.DB as never) });

// Raw-D1 instance used only to drive `ensureMigrated` (Kysely migrator → tables).
const buildMigrationAuth = (env: Env): CirrusAuth => createAuth({ ...authOptions(env), database: env.DB as never });

const buildWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        d1: env.DB,
        // `openApiSpec` (regenerated on every `cirrus/` change) backs the
        // studio's always-current API-reference tab.
        openApiSpec,
        resolveIdentity: async (request) => {
            if (!auth) {
                return null;
            }

            const session = await auth.api.getSession({ headers: request.headers });

            return session?.user?.id ? { userId: session.user.id } : null;
        },
        routes: {} as Record<string, Route>,
        shardDO: env.SHARD,
    });

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        // Memoize init+migration as a single promise so concurrent cold-start
        // requests await the same initialization instead of racing — without this,
        // a second request could see `auth` truthy while the first request's
        // migration is still in flight.
        authReady ??= (async () => {
            auth = buildAuth(env);
            await ensureMigrated(buildMigrationAuth(env));

            return auth;
        })();
        const readyAuth = await authReady;

        const authResponse = await handleAuthRequest(readyAuth, request);

        if (authResponse) {
            return authResponse;
        }

        worker ??= buildWorker(env);

        return worker.fetch(request, env, ctx);
    },
};
