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
 * `resolveIdentity` reads the session as a **bearer** token — React Native has
 * no cookie jar, so the client sends the session in the `Authorization` header
 * on HTTP RPC and as `?token=` on the WebSocket upgrade (a browser can't set
 * headers on a WS handshake). We fold that `?token=` into an `Authorization`
 * header — only on a request carrying `Upgrade: websocket`, so a URL-borne
 * credential never authenticates a plain HTTP call — so better-auth's `bearer`
 * plugin resolves both via `getSession`. A
 * bearer avoids the `Cookie` header the runtime's CSRF guard rejects on an
 * `Origin`-less native request.
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
                    // HTTP RPC carries `Authorization: Bearer <token>`; the WS
                    // upgrade can't set headers, so the client sends the same token
                    // as `?token=`. Fold it into the header the `bearer` plugin reads
                    // — but ONLY on the upgrade. Accepting a query-string credential
                    // on ordinary HTTP requests too would make every URL a bearer
                    // token: session tokens would land in access logs, `Referer`
                    // headers and shared links, and the request would be
                    // authenticated by a value a cross-origin link can set.
                    const headers = new Headers(identityRequest.headers);
                    const isUpgrade = headers.get("upgrade")?.toLowerCase() === "websocket";
                    const wsToken = isUpgrade ? new URL(identityRequest.url).searchParams.get("token") : null;

                    if (wsToken !== null && !headers.has("authorization")) {
                        headers.set("authorization", `Bearer ${wsToken}`);
                    }

                    const session = await auth.api.getSession({ headers });

                    return session?.user?.id ? { userId: session.user.id } : null;
                },
                shardDO: env.SHARD,
            });
        }

        return worker.fetch(request, env, ctx);
    },
};
