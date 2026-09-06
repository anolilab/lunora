/**
 * Payment functions — added by `lunora add payment`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export the functions you want from your `lunora/`
 * entry so codegen picks them up — they surface in the generated `api` as
 * `payment/checkout`, `payment/track`, `payment/check`, `payment/portal`,
 * `payment/mySubscriptions`.
 *
 * The functions are provider-agnostic: they call `ctx.payments.*` which is
 * wired in `createShardDO({ payment: (env) => ({ adapter: ..., ... }) })`.
 *
 * Stripe is the first-class adapter (via `@lunora/payment/stripe`) — see that
 * subpath for `createStripeAdapter({ client, webhookSecret })`, which takes a
 * single options object; Polar and other providers are supported via the
 * `PaymentAdapter` contract.
 *
 * **Post-add wiring** (see `docs` in registry.json):
 *   0. **Declare the payment tables in your own `lunora/schema.ts`.** Copy the
 *      block from `lunora/payment/schema.ts` (shipped by this item) into your
 *      `defineSchema({ … })` call. Codegen parses that file as an AST, so a
 *      spread (`defineSchema({ ...paymentTables })`) is silently skipped, and a
 *      `.extend(...)` merge would prefix the names the store reads. Skip this
 *      and the first `ctx.payments.*` call fails with `UNKNOWN_TABLE`.
 *   1. Wire `payment: (env) => ({ adapter: ..., ... })` in your worker entry
 *      `createShardDO({ ... })` call — the adapter reads `STRIPE_SECRET_KEY`
 *      and `STRIPE_WEBHOOK_SECRET` from env.
 *   2. Add the webhook HTTP route via `httpRouter()`. Answer with
 *      `webhookResponse(result)` — NOT `Response.json(result)`: only the JSON
 *      payload crosses the `runAction` boundary, so the status has to be
 *      re-applied at the edge. Otherwise an orphaned (out-of-order) event's
 *      deliberate 500 becomes a 200, the provider never retries it, and the
 *      update is lost for good.
 *      ```ts
 *      import { webhookResponse } from "@lunora/payment";
 *
 *      // Every header an adapter verifies with; add yours if it signs with another.
 *      const SIGNATURE_HEADERS = ["creem-signature", "stripe-signature", "svix-id", "svix-signature",
 *          "svix-timestamp", "webhook-id", "webhook-signature", "webhook-timestamp"];
 *
 *      app.post("/payment/webhook", httpAction(async (ctx, request) => {
 *          const body = await request.text();
 *          const headers = Object.fromEntries(SIGNATURE_HEADERS.flatMap((name) => {
 *              const value = request.headers.get(name);
 *              return value === null ? [] : [[name, value]];
 *          }));
 *          return webhookResponse(await ctx.runAction(processWebhook, { body, headers }));
 *      }));
 *      ```
 *   3. Run `lunora codegen` to wire `ctx.payments` onto ActionCtx.
 *   4. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `APP_BASE_URL` in
 *      `.dev.vars` (locally) and push the secrets to production with
 *      `wrangler secret put`.
 */
import { env } from "cloudflare:workers";

import { LunoraError } from "@lunora/errors";
import { action, internalAction, query, v } from "#lunora/_generated/server.js";

import { SUBSCRIPTIONS_TABLE } from "./schema.js";

/**
 * Public origin of this deployment, used to build the checkout return URLs and
 * the billing-portal return URL. Read from env rather than the request: a Lunora
 * context carries no `Request` (a mutation can be replayed, a query re-run from
 * a live subscription), so there is nothing to derive an origin from at handler
 * time. Set `APP_BASE_URL` in `.dev.vars` and in production.
 */
const appOrigin = (): string => {
    const value = env["APP_BASE_URL"];

    if (typeof value !== "string" || value === "") {
        throw new Error(
            "@lunora/payment registry item: missing env var `APP_BASE_URL` — set it in .dev.vars (and for production) so checkout/portal return URLs can be built.",
        );
    }

    return new URL(value).origin;
};

/**
 * Start a checkout session and hand the client the redirect URL.
 *
 * The authenticated user (from `ctx.auth.userId`) is the payment reference,
 * so the resulting subscription/customer is linked to them. Requires auth.
 */
export const checkout = action.input({ priceId: v.string().max(512) }).action(async ({ args: { priceId }, ctx }): Promise<{ url: string }> => {
    const referenceId = ctx.auth.userId;

    if (!referenceId) {
        // Coded, not a bare `Error`: an uncoded throw is redacted to a generic
        // 500, so the caller sees a server fault instead of "sign in first".
        throw new LunoraError("UNAUTHORIZED", "@lunora/payment: checkout requires an authenticated user — pass `resolveIdentity` to `createWorker`");
    }

    const result = await ctx.payments.createCheckout({
        cancelUrl: `${appOrigin()}/payment/cancel`,
        mode: "subscription",
        priceId,
        referenceId,
        successUrl: `${appOrigin()}/payment/success`,
    });

    return { url: result.url };
});

/**
 * Record one metered usage event for the authenticated user. `track` writes the
 * durable ledger (exactly-once by idempotency key) and, when the provider
 * supports it, forwards a meter event — best-effort.
 */
export const track = action.action(async ({ ctx }): Promise<{ recorded: boolean }> => {
    const referenceId = ctx.auth.userId;

    if (!referenceId) {
        throw new LunoraError("UNAUTHORIZED", "@lunora/payment: track requires an authenticated user");
    }

    const result = await ctx.payments.track({ featureId: "api_calls", referenceId });

    return { recorded: result.recorded };
});

/**
 * Check whether the authenticated user is still under their metered allowance
 * for the current billing period. Returns the allowance balance when available.
 */
export const check = action.action(async ({ ctx }): Promise<{ allowed: boolean; balance?: number }> => {
    const referenceId = ctx.auth.userId;

    if (!referenceId) {
        throw new LunoraError("UNAUTHORIZED", "@lunora/payment: check requires an authenticated user");
    }

    const result = await ctx.payments.check({ featureId: "api_calls", referenceId });

    return { allowed: result.allowed, balance: result.balance };
});

/**
 * Open the billing portal for the authenticated user (customer derived from the
 * payment store). The return URL is where the portal sends the user after
 * managing their subscription/billing details.
 */
export const portal = action.action(async ({ ctx }): Promise<{ url: string }> => {
    const referenceId = ctx.auth.userId;

    if (!referenceId) {
        throw new LunoraError("UNAUTHORIZED", "@lunora/payment: portal requires an authenticated user");
    }

    return ctx.payments.createPortalSession(referenceId, `${appOrigin()}/account`);
});

interface SubscriptionRow {
    providerSubscriptionId: string;
    referenceId: string;
    state: string;
}

/**
 * Reactive read of the webhook-synced subscriptions for the authenticated user.
 *
 * A `query` rather than an action because this is the one payment read that
 * should stay live — `ctx.payments` is ActionCtx-only, so it reads the
 * `subscriptions` table directly. That table has to exist: declare it in your
 * `lunora/schema.ts` from `lunora/payment/schema.ts` (see the file header).
 *
 * The `by_reference` index is given its `.eq()` predicate, so the scan is bounded
 * to this caller's rows. Without it `withIndex("by_reference")` collects EVERY
 * subscription row in the shard and filters in JS — a full-table read that grows
 * with the customer base, on a path every signed-in page subscribes to.
 */
export const mySubscriptions = query.query(async ({ ctx }): Promise<SubscriptionRow[]> => {
    const referenceId = ctx.auth.userId;

    if (!referenceId) {
        throw new LunoraError("UNAUTHORIZED", "@lunora/payment: mySubscriptions requires an authenticated user");
    }

    const rows = await ctx.db
        .query(SUBSCRIPTIONS_TABLE)
        .withIndex("by_reference", (q) => q.eq("referenceId", referenceId))
        .collect();

    return rows.map((row) => ({
        providerSubscriptionId: row["providerSubscriptionId"] as string,
        referenceId: row["referenceId"] as string,
        state: row["state"] as string,
    }));
});

/**
 * Apply a verified provider webhook. Called by the `POST /payment/webhook` HTTP
 * action (which runs at the Worker edge with no `ctx.db`) so the work happens
 * inside the shard, where `ctx.payments` — and its store — exist.
 *
 * The HTTP route must forward the raw body and every header an adapter can verify
 * with here via `ctx.runAction` — not one named signature header, because which
 * one carries the signature is the provider's choice and these functions are
 * provider-agnostic: Stripe signs with `stripe-signature`, Creem with
 * `creem-signature`, Polar and Dodo Payments with the Standard-Webhooks trio
 * (`webhook-id` / `webhook-timestamp` / `webhook-signature`), Autumn with `svix-*`.
 * Forwarding only `stripe-signature` verified Stripe and failed everything else.
 *
 * An allowlist of those, not the whole `request.headers`: nothing downstream needs
 * a hostile POST's `cookie` / `authorization`, and the entity headers
 * (`content-encoding`, `content-length`) would describe a body that the `text()`
 * below has already decoded.
 */
export const processWebhook = internalAction
    .input({ body: v.string(), headers: v.record(v.string(), v.string()) })
    .action(async ({ args: { body, headers }, ctx }): Promise<{ applied: boolean; status: number }> => {
        // `handleWebhook` reads whichever header the configured adapter verifies with,
        // off the reconstructed request.
        const request = new Request("https://internal/payment/webhook", {
            body,
            headers,
            method: "POST",
        });
        const response = await ctx.payments.handleWebhook(request);
        const result = (await response.json()) as { applied?: boolean };

        return { applied: result.applied ?? false, status: response.status };
    });
