import { webhookResponse } from "@lunora/payment";
import { httpAction, httpRouter } from "lunorash/server";

import { processWebhook } from "./billing.js";

/**
 * The Stripe webhook endpoint.
 *
 * `httpAction` runs at the Worker edge with the *raw* request — required for
 * signature verification (re-serialized JSON wouldn't match the signature). It
 * has no `ctx.db`, so it forwards the raw body + headers into the shard via
 * `ctx.runAction`, where `processWebhook` calls `ctx.payments.handleWebhook`.
 *
 * Only the JSON payload crosses that `runAction` hop, so the status
 * `handleWebhook` chose has to be re-applied here — `webhookResponse` does it.
 * Answering `Response.json(result)` would make every outcome a `200`, including
 * the deliberate `500` on an orphaned (out-of-order) event, and Stripe would
 * never retry it.
 */
export const app = httpRouter();

/**
 * The headers an adapter can verify with — every one `@lunora/payment` reads.
 *
 * Which header carries the signature is the provider's choice, so the route
 * stays provider-agnostic by forwarding all of them: `stripe-signature` here,
 * `creem-signature`, the Standard-Webhooks `webhook-*` trio (Polar, Dodo
 * Payments), `svix-*` (Autumn). Add yours if you wire an adapter that signs with
 * another header.
 *
 * An allowlist rather than `Object.fromEntries(request.headers)`: that forwards
 * a hostile POST's `cookie` / `authorization` into the RPC argument for no
 * reason, and re-attaches entity headers (`content-encoding`, `content-length`)
 * to a `Request` whose body has already been decoded to text — a description of
 * a body that no longer exists.
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
        const body = await request.text();
        const headers = Object.fromEntries(
            SIGNATURE_HEADERS.flatMap((name): [string, string][] => {
                const value = request.headers.get(name);

                return value === null ? [] : [[name, value]];
            }),
        );

        return webhookResponse(await ctx.runAction(processWebhook, { body, headers }));
    }),
);
