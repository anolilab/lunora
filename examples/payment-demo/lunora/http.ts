import { webhookResponse } from "@lunora/payment";
import { httpAction, httpRouter } from "lunorash/server";

import { processWebhook } from "./billing.js";

/**
 * The Stripe webhook endpoint.
 *
 * `httpAction` runs at the Worker edge with the *raw* request — required for
 * signature verification (re-serialized JSON wouldn't match the signature). It
 * has no `ctx.db`, so it forwards the raw body + signature into the shard via
 * `ctx.runAction`, where `processWebhook` calls `ctx.payments.handleWebhook`.
 *
 * Only the JSON payload crosses that `runAction` hop, so the status
 * `handleWebhook` chose has to be re-applied here — `webhookResponse` does it.
 * Answering `Response.json(result)` would make every outcome a `200`, including
 * the deliberate `500` on an orphaned (out-of-order) event, and Stripe would
 * never retry it.
 */
export const app = httpRouter();

app.post(
    "/payment/webhook",
    httpAction(async (ctx, request) => {
        const body = await request.text();
        const signature = request.headers.get("stripe-signature") ?? "";

        return webhookResponse(await ctx.runAction(processWebhook, { body, signature }));
    }),
);
