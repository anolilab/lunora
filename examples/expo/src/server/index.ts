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
let authReady: null | Promise<ReturnType<typeof buildAuth>> = null;

/**
 * Build the auth instance exactly once — even under concurrent requests — and
 * only *after* `ensureMigrated` has created the better-auth tables. Every caller
 * awaits the same promise, so no request can reach `handleAuthRequest` /
 * `getSession` before the schema exists (assigning the instance before awaiting
 * migrations would let a concurrent request slip through that window). On
 * failure the promise is cleared so the next request retries instead of caching
 * a permanent error.
 */
const ensureAuthReady = (env: Env): Promise<ReturnType<typeof buildAuth>> => {
    if (!authReady) {
        authReady = (async (): Promise<ReturnType<typeof buildAuth>> => {
            await ensureMigrated(buildMigrationAuth({ AUTH_SECRET: env.AUTH_SECRET, AUTH_URL: env.AUTH_URL, DB: env.DB }));

            return buildAuth({ AUTH_SECRET: env.AUTH_SECRET, AUTH_URL: env.AUTH_URL, DB: env.DB });
        })().catch((error: unknown) => {
            authReady = null;

            throw error;
        });
    }

    return authReady;
};

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
        const auth = await ensureAuthReady(env);

        const authResponse = await handleAuthRequest(auth, request);

        if (authResponse) {
            return authResponse;
        }

        if (!worker) {
            worker = createWorker({
                openApiSpec,
                resolveIdentity: async (identityRequest) => {
                    const session = await auth.api.getSession({ headers: identityRequest.headers });

                    return session?.user?.id ? { userId: session.user.id } : null;
                },
                shardDO: env.SHARD,
            });
        }

        return worker.fetch(request, env, ctx);
    },
};
