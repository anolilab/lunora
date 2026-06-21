import type { StripeClientLike } from "@lunora/payment";
import { createStripeAdapter } from "@lunora/payment";
import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";
import Stripe from "stripe";

import { app } from "../../lunora/http.js";
import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

interface Env {
    SHARD: ShardNamespaceLike;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
}

/**
 * `config.payment(env)` builds the provider adapter from env secrets; the
 * generated ShardDO then assembles `ctx.payments` per request with the store on
 * `ctx.db`. The demo's `authorize: () => true` is a stand-in — a real app ties
 * the referenceId to `ctx.auth.userId` (the default authorizer does exactly that).
 */
export const ShardDO = createShardDO({
    payment: (env) => {
        const environment = env as unknown as Env;

        return {
            adapter: createStripeAdapter({
                // A real `Stripe` instance satisfies the structural client; the cast
                // keeps the package free of a hard `stripe` dependency.
                client: new Stripe(environment.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }) as unknown as StripeClientLike,
                webhookSecret: environment.STRIPE_WEBHOOK_SECRET,
            }),
            authorize: () => true,
            // Plan → features/limits map powering `ctx.payments.check`. The `pro`
            // plan grants a metered cap of 1000 `api_calls`, decremented by `track`.
            entitlements: {
                plans: {
                    pro: { features: ["export"], limits: { api_calls: 1000 }, priceIds: ["price_123"] },
                },
            },
            // Telemetry hook: failed payments, past-due subscriptions, reconciliation
            // drift, and general webhook applies — route to logs/metrics/alerts.
            observability: (event) => {
                console.log("[payment]", event.type, event);
            },
        };
    },
});

let worker: ReturnType<typeof createWorker> | null = null;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            // `httpRouter: app` mounts the `POST /payment/webhook` action; everything
            // else falls through to Lunora's RPC + reactive query surface.
            worker = createWorker({ httpRouter: app, openApiSpec, shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
