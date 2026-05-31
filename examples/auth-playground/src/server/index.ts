import { ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

import { buildAuth } from "../../cirrus/auth.js";
import { createShardDO } from "../../cirrus/_generated/shard.js";

export const ShardDO = createShardDO();

interface Env {
    AUTH_SECRET: string;
    DB: unknown;
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;
let authInstance: ReturnType<typeof buildAuth> | null = null;

/**
 * Worker entry for the auth-playground demo.
 *
 * Routing precedence:
 *
 * 1. `/api/auth/*` — `handleAuthRequest` delegates the request to better-auth's
 *    own router (sign-up, sign-in, OAuth callbacks, org/admin endpoints).
 * 2. Everything else — falls through to Cirrus's RPC + HTTP-action surface.
 *
 * `ensureMigrated` runs better-auth's migration sweep against the configured
 * D1 binding. It is idempotent and cheap (just a schema diff) so calling it
 * per request inside dev is fine; for production prefer `compileMigrationsSql`
 * + `wrangler d1 execute` at deploy time.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!authInstance) {
            authInstance = buildAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB });
        }

        // Idempotent — `ensureMigrated` caches per-options after the first run.
        await ensureMigrated(authInstance);

        const authResponse = await handleAuthRequest(authInstance, request);

        if (authResponse) {
            return authResponse;
        }

        if (!worker) {
            worker = createWorker({ shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
