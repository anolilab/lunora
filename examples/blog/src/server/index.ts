import type { CirrusAuth } from "@cirrus/auth";
import { createAuth, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import type { ExecutionContextLike, Route, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

export { SchedulerDO } from "./scheduler-do.js";
export { ShardDO } from "./shard-do.js";

interface Env {
    AUTH_SECRET?: string;
    AUTH_URL?: string;
    DB: unknown;
    FILES: unknown;
    SCHEDULER: ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
    STORAGE_SECRET?: string;
}

let worker: ReturnType<typeof createWorker> | null = null;
let auth: CirrusAuth | null = null;

/**
 * Compose the full v0.1 add-on stack: better-auth for email/password sign-in
 * (`@cirrus/auth`), sharded function dispatch from `@cirrus/runtime`, and
 * D1-backed user storage.
 */
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
        if (!auth) {
            auth = buildAuth(env);
            await ensureMigrated(auth);
        }

        const authResponse = await handleAuthRequest(auth, request);

        if (authResponse) {
            return authResponse;
        }

        worker ??= buildWorker(env);

        return worker.fetch(request, env, ctx);
    },
};
