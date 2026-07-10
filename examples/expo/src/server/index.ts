import { ensureMigrated, handleAuthRequest } from "@lunora/auth";
import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";
import { buildAuth, buildMigrationAuth } from "../../lunora/auth.js";

export const ShardDO = createShardDO();

interface Env {
    AUTH_SECRET: string;
    /** Base URL better-auth resolves callback/cookie origins against (the deployed worker URL). */
    AUTH_URL?: string;
    DB: unknown;
    SHARD: ShardNamespaceLike;
}

let worker: null | ReturnType<typeof createWorker> = null;
let authInstance: null | ReturnType<typeof buildAuth> = null;

/**
 * Worker entry for the Expo example — the same shape as any Lunora worker with
 * `@lunora/auth`, serving the mobile client:
 *
 * 1. `/api/auth/*` → better-auth's router (sign-up, sign-in, get-session). The
 *    Expo plugin's routes and the app-scheme trusted origin live here too.
 * 2. Everything else → Lunora's RPC + WebSocket surface.
 *
 * `resolveIdentity` reads the session from the request headers — the mobile
 * client has no cookie jar, so it attaches the session `Cookie` explicitly (via
 * `@lunora/react-native/auth`'s `expoAuthHeaders`) to both HTTP RPC and the
 * WebSocket upgrade, and `getSession` reads it the same way here.
 *
 * `ensureMigrated` creates the better-auth tables once, on the first request —
 * fine for a demo; for production prefer `compileMigrationsSql` +
 * `wrangler d1 execute` at deploy time.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!authInstance) {
            authInstance = buildAuth({ AUTH_SECRET: env.AUTH_SECRET, AUTH_URL: env.AUTH_URL, DB: env.DB });

            await ensureMigrated(buildMigrationAuth({ AUTH_SECRET: env.AUTH_SECRET, AUTH_URL: env.AUTH_URL, DB: env.DB }));
        }

        const authResponse = await handleAuthRequest(authInstance, request);

        if (authResponse) {
            return authResponse;
        }

        if (!worker) {
            worker = createWorker({
                openApiSpec,
                resolveIdentity: async (identityRequest) => {
                    // `authInstance` is always set above before any request work.
                    const session = await authInstance!.api.getSession({ headers: identityRequest.headers });

                    return session?.user?.id ? { userId: session.user.id } : null;
                },
                shardDO: env.SHARD,
            });
        }

        return worker.fetch(request, env, ctx);
    },
};
