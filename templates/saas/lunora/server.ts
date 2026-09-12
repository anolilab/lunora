import { createStripeAdapter } from "@lunora/payment/stripe";
import type { ShardNamespaceLike } from "lunorash/runtime";
import Stripe from "stripe";

import { getAuth } from "./auth/index.js";
import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    DB: unknown;
    SHARD: ShardNamespaceLike;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
}

/**
 * Plan ids → what they unlock, for `ctx.payments.check`.
 *
 * This has to agree with the catalog the pricing page renders
 * (`src/routes/settings.billing.tsx`) — same plan ids, same feature names. They
 * are separate because they answer to different owners: this one gates a
 * mutation and is the one that matters, that one renders a price and is the one
 * a designer edits.
 */
const ENTITLEMENTS = {
    plans: {
        pro: { features: ["export", "admin"], priceIds: ["price_pro"] },
        scale: { features: ["export", "admin", "sso"], priceIds: ["price_scale"] },
    },
};

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
    .payment((env) => {
        const environment = env as unknown as Env;

        return {
            adapter: createStripeAdapter({
                // `stripe` is an optional peer dependency; the fetch HTTP client is
                // required on workerd.
                client: new Stripe(environment.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }),
                webhookSecret: environment.STRIPE_WEBHOOK_SECRET,
            }),
            /*
             * No `authorize` override: `AuthorizeReference` receives only the
             * reference id, with no identity to compare it against, so the tenant
             * check cannot live here. It lives where `ctx.auth` does — the
             * functions in `lunora/payment/index.ts` derive `referenceId` from
             * the caller's active organisation and never take it as an argument,
             * which is the same rule the rest of this app follows.
             */
            entitlements: ENTITLEMENTS,
            /*
             * Failed payments, past-due subscriptions and reconciliation drift
             * arrive here. Route them at your alerting — a dunning failure nobody
             * sees is a cancellation in three weeks' time.
             */
            observability: (event) => {
                console.log("[payment]", event.type, event);
            },
        };
    })
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

            /*
             * `organization()` and `admin()` add these three fields at runtime,
             * but `createAuth` is declared to return the erased `LunoraAuth`, so
             * better-auth's plugin inference never reaches a consumer — the
             * fields are invisible to TypeScript however the instance is
             * annotated downstream.
             *
             * Reading them through one narrow shape at this single boundary is
             * the containment: the claims are validated against the contract in
             * `lunora/identity.ts` immediately afterwards, and a claim set that
             * does not match is rejected with a 401 rather than trusted.
             */
            const scoped = session.session as { activeOrganizationId?: string; activeOrganizationRole?: string };
            const user = session.user as { id: string; role?: string };

            return {
                activeOrganizationId: scoped.activeOrganizationId ?? undefined,
                appRole: user.role ?? undefined,
                orgRole: scoped.activeOrganizationRole ?? undefined,
                userId: user.id,
            };
        },
    }))
    .build();

export const ShardDO = app.ShardDO;
export default app;
