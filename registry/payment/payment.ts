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
 * subpath for `createStripeAdapter(client, webhookSecret)`; Polar and other
 * providers are supported via the `PaymentAdapter` contract.
 *
 * **Post-add wiring** (see `docs` in registry.json):
 *   1. Wire `payment: (env) => ({ adapter: ..., ... })` in your worker entry
 *      `createShardDO({ ... })` call — the adapter reads `STRIPE_SECRET_KEY`
 *      and `STRIPE_WEBHOOK_SECRET` from env.
 *   2. Add the webhook HTTP route via `httpRouter()`:
 *      ```ts
 *      app.post("/payment/webhook", httpAction(async (ctx, request) => {
 *          const body = await request.text();
 *          const signature = request.headers.get("stripe-signature") ?? "";
 *          const result = await ctx.runAction(processWebhook, { body, signature });
 *          return Response.json(result);
 *      }));
 *      ```
 *   3. Run `lunora codegen` to wire `ctx.payments` onto ActionCtx.
 *   4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.dev.vars`
 *      (locally) and push to production with `wrangler secret put`.
 */
import { action, internalAction, query, v } from "#lunora/_generated/server.js";

/**
 * Start a checkout session and hand the client the redirect URL.
 *
 * The authenticated user (from `ctx.auth.userId`) is the payment reference,
 * so the resulting subscription/customer is linked to them. Requires auth.
 */
export const checkout = action
    .input({ priceId: v.string().meta({ schema: { maxLength: 512 } }) })
    .action(async ({ args: { priceId }, ctx }): Promise<{ url: string }> => {
        const referenceId = ctx.auth.userId;

        if (!referenceId) {
            throw new Error("@lunora/payment: checkout requires an authenticated user — pass `resolveIdentity` to `createWorker`");
        }

        const result = await ctx.payments.createCheckout({
            cancelUrl: `${new URL(ctx.request.url).origin}/payment/cancel`,
            mode: "subscription",
            priceId,
            referenceId,
            successUrl: `${new URL(ctx.request.url).origin}/payment/success`,
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
        throw new Error("@lunora/payment: track requires an authenticated user");
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
        throw new Error("@lunora/payment: check requires an authenticated user");
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
        throw new Error("@lunora/payment: portal requires an authenticated user");
    }

    return ctx.payments.createPortalSession(referenceId, `${new URL(ctx.request.url).origin}/account`);
});

interface SubscriptionRow {
    providerSubscriptionId: string;
    referenceId: string;
    state: string;
}

/** Reactive read of the webhook-synced subscriptions for the authenticated user. */
export const mySubscriptions = query.query(async ({ ctx }): Promise<SubscriptionRow[]> => {
    const referenceId = ctx.auth.userId;

    if (!referenceId) {
        throw new Error("@lunora/payment: mySubscriptions requires an authenticated user");
    }

    const rows = await ctx.db.query("subscriptions").withIndex("by_reference").collect();

    return rows.filter((subscription) => subscription.referenceId === referenceId);
});

/**
 * Apply a verified provider webhook. Called by the `POST /payment/webhook` HTTP
 * action (which runs at the Worker edge with no `ctx.db`) so the work happens
 * inside the shard, where `ctx.payments` — and its store — exist.
 *
 * The HTTP route must extract the raw body and the provider-specific signature
 * header from the incoming request and forward them here via `ctx.runAction`.
 *
 * Stripe example headers: `stripe-signature`
 * Polar example headers: `polar-signature`
 */
export const processWebhook = internalAction
    .input({ body: v.string(), signature: v.string() })
    .action(async ({ args: { body, signature }, ctx }): Promise<{ applied: boolean; status: number }> => {
        // `handleWebhook` reads the provider-specific signature header from the
        // reconstructed request — the caller passes the header value as `signature`
        // and the HTTP route's provider header name is baked into the adapter config.
        const request = new Request("https://internal/payment/webhook", {
            body,
            headers: { "stripe-signature": signature },
            method: "POST",
        });
        const response = await ctx.payments.handleWebhook(request);
        const result = (await response.json()) as { applied?: boolean };

        return { applied: result.applied ?? false, status: response.status };
    });
