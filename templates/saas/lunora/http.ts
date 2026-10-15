import { webhookResponse } from "@lunora/payment";
import { httpAction, httpRouter } from "lunorash/server";

import { internal } from "./_generated/api";

const app = httpRouter();

/**
 * The provider's webhook. Answer with `webhookResponse(result)` and never
 * `Response.json(result)`: only the JSON payload crosses the `runAction`
 * boundary, so the status has to be re-applied here. Without it, an orphaned
 * (out-of-order) event's deliberate 500 becomes a 200, the provider never
 * retries it, and that update is lost for good.
 *
 * Every header any adapter verifies with is forwarded, so swapping Stripe for
 * one of the other five providers needs no change here.
 */
const SIGNATURE_HEADERS = [
    "creem-signature",
    "stripe-signature",
    "svix-id",
    "svix-signature",
    "svix-timestamp",
    "webhook-id",
    "webhook-signature",
    "webhook-timestamp",
];

app.post(
    "/payment/webhook",
    httpAction(async (ctx, request) => {
        const headers: Record<string, string> = {};

        for (const name of SIGNATURE_HEADERS) {
            const value = request.headers.get(name);

            if (value !== null) {
                headers[name] = value;
            }
        }

        const result = await ctx.runAction(internal.payment.processWebhook, { body: await request.text(), headers });

        return webhookResponse(result);
    }),
);

export default app;
