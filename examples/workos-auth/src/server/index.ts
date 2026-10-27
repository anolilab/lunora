import { workos } from "@lunora/jwt-auth";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { memoizeIdentity } from "lunorash/runtime";

import { defineApp } from "../../lunora/_generated/app.js";

interface Env {
    SHARD: ShardNamespaceLike;
    /** Optional custom auth domain; it then issues the tokens instead of api.workos.com. */
    WORKOS_AUTH_DOMAIN?: string;
    /** The WorkOS client id: it names the JWKS and must match each token's `client_id`. */
    WORKOS_CLIENT_ID?: string;
}

/**
 * WorkOS owns the session; the worker only verifies it. `workos(...)` checks
 * each request's AuthKit access token (`Authorization: Bearer`, or — on a
 * live-query socket — the bearer the client offers as a
 * `Sec-WebSocket-Protocol`) against the client's JWKS and maps it to
 * `ctx.auth`. There is no builder sugar for this: `.extend()` sets
 * `resolveIdentity`, which is all an external provider needs.
 *
 * `memoizeIdentity` reuses a verification for the same token for 5 s, which
 * collapses a page load's burst of calls. That is also the revocation delay —
 * keep it in seconds.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .extend((env) => {
        return {
            resolveIdentity: memoizeIdentity(
                workos({
                    ...(env.WORKOS_AUTH_DOMAIN ? { authDomain: env.WORKOS_AUTH_DOMAIN } : {}),
                    clientId: env.WORKOS_CLIENT_ID ?? "",
                }),
            ),
        };
    })
    .build();

export const { ShardDO } = app;

// The composed app IS the module worker — see examples/chess for why it is exported wholesale.
export default app;
