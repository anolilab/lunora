import { httpAction, httpRouter } from "@lunora/server";

import { processWebhook } from "./billing.js";

/**
 * The Stripe webhook endpoint.
 *
 * `httpAction` runs at the Worker edge with the *raw* request — required for
 * signature verification (re-serialized JSON wouldn't match the signature). It
 * has no `ctx.db`, so it forwards the raw body + signature into the shard via
 * `ctx.runAction`, where `processWebhook` calls `ctx.payments.handleWebhook`.
 */
export const app = httpRouter();

app.post(
    "/payment/webhook",
    httpAction(async (ctx, request) => {
        const body = await request.text();
        const signature = request.headers.get("stripe-signature") ?? "";
        const result = await ctx.runAction(processWebhook, { body, signature });

        return Response.json(result);
    }),
);
