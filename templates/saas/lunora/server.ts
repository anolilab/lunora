import type { ShardNamespaceLike } from "lunorash/runtime";

import { getAuth } from "./auth/index.js";
import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    DB: unknown;
    SHARD: ShardNamespaceLike;
}

/**
 * The worker, and the two callbacks that make tenant-per-shard real.
 *
 * `resolveIdentity` turns the better-auth session into the claim set declared in
 * `lunora/identity.ts`. The runtime validates it against that contract before it
 * becomes `ctx.auth`, and `onInvalid: "reject"` means a malformed claim set
 * fails closed with a 401 rather than arriving as an anonymous caller.
 *
 * `authorizeShard` is the boundary itself. Every sharded table in this app is
 * `.shardBy("organizationId")`, so the shard key IS the tenant id — a caller may
 * enter their active organisation's shard and no other. Without this gate the
 * tenancy model is decoration: the functions read the tenant from the identity,
 * but the transport would still carry a request to any shard the caller named.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .extend((env) => ({
        /**
         * A caller may enter their own tenant's shard, plus the root shard —
         * which holds the unsharded tables (rate-limit buckets and anything you
         * add without `.shardBy`), so every signed-in user needs it.
         *
         * Anonymous callers get nothing. The scheduler and queue consumers are
         * exempt from this callback by the runtime (they authenticate first and
         * carry no end-user identity), so an `identity: null` here is always a
         * real anonymous end user.
         *
         * Fan-out is denied by default once this is set, and that is correct for
         * this app: it runs no cross-shard table query. The admin's only
         * cross-tenant read is `saas_organizations`, which is `.global()` and
         * served from D1 — a different path entirely. Add `authorizeFanOut` if
         * you introduce one, and think hard about who may trigger it.
         */
        authorizeShard: ({ identity, shardKey }) => {
            if (!identity?.userId) {
                return false;
            }

            return shardKey === "__root__" || identity.activeOrganizationId === shardKey;
        },

        resolveIdentity: async (request: Request) => {
            const session = await getAuth(env as never).api.getSession({ headers: request.headers });

            if (!session) {
                return null;
            }

            return {
                activeOrganizationId: session.session.activeOrganizationId ?? undefined,
                appRole: session.user.role ?? undefined,
                orgRole: session.session.activeOrganizationRole ?? undefined,
                userId: session.user.id,
            };
        },
    }))
    .build();

export const ShardDO = app.ShardDO;
export default app;
