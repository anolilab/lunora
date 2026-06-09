import { ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

import { createShardDO } from "../../cirrus/_generated/shard.js";
import { buildAuth, buildMigrationAuth } from "../../cirrus/auth.js";

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
 * `ensureMigrated` runs better-auth's migration sweep against the raw D1 binding
 * (the Kysely migrator that creates the tables the runtime SQL adapter then uses)
 * once, on the first request. For production prefer `compileMigrationsSql`
 * + `wrangler d1 execute` at deploy time.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!authInstance) {
            authInstance = buildAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB });

            // Create tables via the raw-D1 Kysely migrator (the runtime adapter issues no DDL).
            await ensureMigrated(buildMigrationAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB }));
        }

        const authResponse = await handleAuthRequest(authInstance, request);

        if (authResponse) {
            return authResponse;
        }

        if (!worker) {
            worker = createWorker({
                resolveIdentity: async (identityRequest) => {
                    // `authInstance` is always set by the time we reach here — it is built
                    // at the top of `fetch` before any request work happens.
                    const session = await authInstance!.api.getSession({ headers: identityRequest.headers });

                    return session?.user?.id ? { userId: session.user.id } : null;
                },
                shardDO: env.SHARD,
            });
        }

        return worker.fetch(request, env, ctx);
    },
};
