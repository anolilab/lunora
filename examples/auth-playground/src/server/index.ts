import { ensureMigrated, handleAuthRequest } from "@lunora/auth";
import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";
import { buildAuth, buildMigrationAuth } from "../../lunora/auth.js";

export const ShardDO = createShardDO();

interface Env {
    AUTH_SECRET: string;
    DB: unknown;
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;
let authInstance: ReturnType<typeof buildAuth> | null = null;
let authReady: Promise<ReturnType<typeof buildAuth>> | null = null;

/**
 * Worker entry for the auth-playground demo.
 *
 * Routing precedence:
 *
 * 1. `/api/auth/*` — `handleAuthRequest` delegates the request to better-auth's
 *    own router (sign-up, sign-in, OAuth callbacks, org/admin endpoints).
 * 2. Everything else — falls through to Lunora's RPC + HTTP-action surface.
 *
 * `ensureMigrated` runs better-auth's migration sweep against the raw D1 binding
 * (the Kysely migrator that creates the tables the runtime SQL adapter then uses)
 * once, on the first request. For production prefer `compileMigrationsSql`
 * + `wrangler d1 execute` at deploy time.
 *
 * Init and migration are memoized as a SINGLE promise, and every request awaits
 * it. Assigning `authInstance` before awaiting `ensureMigrated` would let a
 * second concurrent cold-start request see a non-null instance and serve
 * `/api/auth/*` against tables that do not exist yet.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        authReady ??= (async () => {
            const instance = buildAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB });

            try {
                // Create tables via the raw-D1 Kysely migrator (the runtime adapter issues no DDL).
                await ensureMigrated(buildMigrationAuth({ AUTH_SECRET: env.AUTH_SECRET, DB: env.DB }));
            } catch (error) {
                // Memoising the PROMISE means a rejection is memoised too: without
                // this, one failed cold-start migration (a D1 blip) would be
                // replayed to every later request for the isolate's whole life,
                // with no path back to a working state. Drop it so the next
                // request retries.
                // eslint-disable-next-line unicorn/no-null -- matches the declared `Promise<Auth> | null`; `??=` re-runs on either nullish value
                authReady = null;

                throw error;
            }

            // Published only once the tables exist, so `resolveIdentity` below can
            // never observe a half-initialized instance.
            authInstance = instance;

            return instance;
        })();

        const readyAuth = await authReady;
        const authResponse = await handleAuthRequest(readyAuth, request);

        if (authResponse) {
            return authResponse;
        }

        if (!worker) {
            worker = createWorker({
                // `openApiSpec` (regenerated on every `lunora/` change) backs the
                // studio's always-current API-reference tab.
                openApiSpec,
                resolveIdentity: async (identityRequest) => {
                    // Set by the memoized init above, which every request awaits
                    // before reaching here.
                    if (!authInstance) {
                        return null;
                    }

                    const session = await authInstance.api.getSession({ headers: identityRequest.headers });

                    return session?.user?.id ? { userId: session.user.id } : null;
                },
                shardDO: env.SHARD,
            });
        }

        return worker.fetch(request, env, ctx);
    },
};
