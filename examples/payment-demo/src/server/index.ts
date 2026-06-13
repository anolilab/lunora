import type { StripeClientLike } from "@cirrus/payment";
import { createStripeAdapter } from "@cirrus/payment";
import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
import Stripe from "stripe";

import { app } from "../../cirrus/http.js";
import { openApiSpec } from "../../cirrus/_generated/openapi.js";
import { createShardDO } from "../../cirrus/_generated/shard.js";

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
        };
    },
});

let worker: ReturnType<typeof createWorker> | null = null;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            // `httpRouter: app` mounts the `POST /payment/webhook` action; everything
            // else falls through to Cirrus's RPC + reactive query surface.
            worker = createWorker({ httpRouter: app, openApiSpec, shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
