import { clerk } from "@lunora/jwt-auth";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { memoizeIdentity } from "lunorash/runtime";

import { defineApp } from "../../lunora/_generated/app.js";

interface Env {
    /** Comma-separated frontend origins, checked against the session token's `azp`. */
    CLERK_AUTHORIZED_PARTIES?: string;
    /** The publishable key: it encodes the Frontend API that issues (and signs) session tokens. */
    CLERK_PUBLISHABLE_KEY?: string;
    SHARD: ShardNamespaceLike;
}

/**
 * Clerk owns the session; the worker only verifies it. `clerk(...)` checks each
 * request's session token (`Authorization: Bearer`, the `__session` cookie on a
 * same-origin request, or — on a live-query socket — the bearer the client
 * offers as a `Sec-WebSocket-Protocol`) against the instance's JWKS and maps it
 * to `ctx.auth`. There is no builder sugar for this: `.extend()` sets
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
                clerk({
                    authorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(",")
                        .map((origin) => origin.trim())
                        .filter((origin) => origin.length > 0),
                    publishableKey: env.CLERK_PUBLISHABLE_KEY ?? "",
                }),
            ),
        };
    })
    .build();

export const { ShardDO } = app;

// The composed app IS the module worker — see examples/chess for why it is exported wholesale.
export default app;
