import { createAuth, providers } from "@cirrus/auth";
import type { ExecutionContextLike, Route, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

export { SchedulerDO } from "./SchedulerDO.js";
export { ShardDO } from "./ShardDO.js";

interface Env {
    AUTH_SECRET?: string;
    DB: unknown;
    FILES: unknown;
    SCHEDULER: ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
    STORAGE_SECRET?: string;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Compose the full v0.1 add-on stack: email/password auth from
 * `@cirrus/auth`, sharded function dispatch from `@cirrus/runtime`, and
 * D1-backed `users` lookups.
 */
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
        routes: auth.routes() as unknown as Record<string, Route>,
        shardDO: env.SHARD,
    });
};

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            worker = buildWorker(env);
        }

        return worker.fetch(request, env, ctx);
    },
};
