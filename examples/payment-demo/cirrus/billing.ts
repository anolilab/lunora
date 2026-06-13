import { action, internalAction, query, v } from "./_generated/server.js";

// A real app keys checkout on the signed-in user (`ctx.auth.userId`); this demo
// has no auth, so it uses a fixed reference and an allow-all authorizer (wired in
// the worker's `createShardDO({ payment })` config).
const DEMO_REFERENCE = "demo-user";

/**
 * Start a Stripe Checkout session and hand the client the redirect URL.
 *
 * `ctx.payments` is the facade codegen wires onto `ActionCtx` when it sees this
 * file reach for it — the store rides this request's `ctx.db`.
 */
export const checkout = action({
    args: { priceId: v.string() },
    handler: async (ctx, { priceId }): Promise<{ url: string }> => {
        const result = await ctx.payments.createCheckout({
            cancelUrl: "https://example.com/cancel",
            mode: "subscription",
            priceId,
            referenceId: DEMO_REFERENCE,
            successUrl: "https://example.com/success",
        });

        return { url: result.url };
    },
});

interface SubscriptionRow {
    providerSubscriptionId: string;
    referenceId: string;
    state: string;
}

/** Open the Stripe billing portal for the demo reference (customer derived from the store). */
export const portal = action({
    args: {},
    handler: async (ctx): Promise<{ url: string }> => ctx.payments.createPortalSession(DEMO_REFERENCE, "https://example.com/account"),
});

/** Reactive read of the webhook-synced subscriptions for the demo reference. */
export const mySubscriptions = query({
    args: {},
    handler: async (ctx): Promise<SubscriptionRow[]> => {
        const rows = (await ctx.db.query("subscriptions").withIndex("by_reference").collect()) as unknown as SubscriptionRow[];

        return rows.filter((subscription) => subscription.referenceId === DEMO_REFERENCE);
    },
});

/**
 * Apply a verified Stripe webhook. Called by the `POST /payment/webhook` HTTP
 * action (which runs at the Worker edge with no `ctx.db`) so the work happens
 * inside the shard, where `ctx.payments` — and its store — exist.
 */
export const processWebhook = internalAction({
    args: { body: v.string(), signature: v.string() },
    handler: async (ctx, { body, signature }): Promise<{ applied: boolean; status: number }> => {
        const request = new Request("https://internal/payment/webhook", {
            body,
            headers: { "stripe-signature": signature },
            method: "POST",
        });
        const response = await ctx.payments.handleWebhook(request);
        const result = (await response.json()) as { applied?: boolean };

        return { applied: result.applied ?? false, status: response.status };
    },
});
