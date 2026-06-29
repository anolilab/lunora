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
export const checkout = action.input({ priceId: v.string() }).action(async ({ args: { priceId }, ctx }): Promise<{ url: string }> => {
    const result = await ctx.payments.createCheckout({
        cancelUrl: "https://example.com/cancel",
        mode: "subscription",
        priceId,
        referenceId: DEMO_REFERENCE,
        successUrl: "https://example.com/success",
    });

    return { url: result.url };
});

interface SubscriptionRow {
    providerSubscriptionId: string;
    referenceId: string;
    state: string;
}

/**
 * Record one metered `api_calls` usage event for the demo reference. `track`
 * writes the durable ledger (exactly-once by idempotency key) and, since Stripe
 * advertises usage metering, forwards a meter event — best-effort.
 */
export const recordApiCall = action.action(async ({ ctx }): Promise<{ recorded: boolean }> => {
    const result = await ctx.payments.track({ featureId: "api_calls", referenceId: DEMO_REFERENCE });

    return { recorded: result.recorded };
});

/** Is the demo reference still under its metered `api_calls` allowance this period? */
export const apiCallsRemaining = action.action(async ({ ctx }): Promise<{ allowed: boolean; balance?: number }> => {
    const result = await ctx.payments.check({ featureId: "api_calls", referenceId: DEMO_REFERENCE });

    return { allowed: result.allowed, balance: result.balance };
});

/** Open the Stripe billing portal for the demo reference (customer derived from the store). */
export const portal = action.action(async ({ ctx }): Promise<{ url: string }> =>
    ctx.payments.createPortalSession(DEMO_REFERENCE, "https://example.com/account"),
);

/** Reactive read of the webhook-synced subscriptions for the demo reference. */
export const mySubscriptions = query.query(async ({ ctx }): Promise<SubscriptionRow[]> => {
    const rows = await ctx.db.query("subscriptions").withIndex("by_reference").collect();

    return rows.filter((subscription) => subscription.referenceId === DEMO_REFERENCE);
});

/**
 * Apply a verified Stripe webhook. Called by the `POST /payment/webhook` HTTP
 * action (which runs at the Worker edge with no `ctx.db`) so the work happens
 * inside the shard, where `ctx.payments` — and its store — exist.
 */
export const processWebhook = internalAction
    .input({ body: v.string(), signature: v.string() })
    .action(async ({ args: { body, signature }, ctx }): Promise<{ applied: boolean; status: number }> => {
        const request = new Request("https://internal/payment/webhook", {
            body,
            headers: { "stripe-signature": signature },
            method: "POST",
        });
        const response = await ctx.payments.handleWebhook(request);
        const result = (await response.json()) as { applied?: boolean };

        return { applied: result.applied ?? false, status: response.status };
    });
