import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { ActionCtx } from "./_generated/server.js";
import { action, internalAction, query, v } from "./_generated/server.js";

// A real app keys checkout on the signed-in user (`ctx.auth.userId`); this demo
// has no auth, so it uses a fixed reference and an allow-all authorizer (wired in
// the worker's `createShardDO({ payment })` config).
const DEMO_REFERENCE = "demo-user";

/**
 * Every public action below performs an outbound call to Stripe on the
 * deployer's own account. With no sign-in, a rate limit keyed on the caller's
 * server-trusted `ctx.ip` is the only thing between a deployed instance and a
 * script running up an API bill — so it is not optional decoration here.
 *
 * A real app keys these on `ctx.auth.userId` (falling back to `ctx.ip` for
 * anonymous callers) and never on anything out of `args`, which a caller can
 * rotate per request to get a fresh bucket every time.
 */
const limiter = (ctx: ActionCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: { ip?: string }): string => ctx.ip ?? "anon" };

/**
 * Start a Stripe Checkout session and hand the client the redirect URL.
 *
 * `ctx.payments` is the facade codegen wires onto `ActionCtx` when it sees this
 * file reach for it — the store rides this request's `ctx.db`.
 */
export const checkout = action
    .input({ priceId: v.string().max(256) })
    .use(rateLimit(limiter, "checkout", byCaller))
    .action(async ({ args: { priceId }, ctx }): Promise<{ url: string }> => {
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
export const recordApiCall = action.use(rateLimit(limiter, "meter", byCaller)).action(async ({ ctx }): Promise<{ recorded: boolean }> => {
    const result = await ctx.payments.track({ featureId: "api_calls", referenceId: DEMO_REFERENCE });

    return { recorded: result.recorded };
});

/** Is the demo reference still under its metered `api_calls` allowance this period? */
export const apiCallsRemaining = action.use(rateLimit(limiter, "meter", byCaller)).action(async ({ ctx }): Promise<{ allowed: boolean; balance?: number }> => {
    const result = await ctx.payments.check({ featureId: "api_calls", referenceId: DEMO_REFERENCE });

    return { allowed: result.allowed, balance: result.balance };
});

/** Open the Stripe billing portal for the demo reference (customer derived from the store). */
export const portal = action
    .use(rateLimit(limiter, "checkout", byCaller))
    .action(async ({ ctx }): Promise<{ url: string }> => ctx.payments.createPortalSession(DEMO_REFERENCE, "https://example.com/account"));

/** Reactive read of the webhook-synced subscriptions for the demo reference. */
export const mySubscriptions = query.query(async ({ ctx }): Promise<SubscriptionRow[]> => {
    const rows = await ctx.db.query("subscriptions").withIndex("by_reference").collect();

    return rows.filter((subscription) => subscription.referenceId === DEMO_REFERENCE);
});

/**
 * Apply a verified Stripe webhook. Called by the `POST /payment/webhook` HTTP
 * action (which runs at the Worker edge with no `ctx.db`) so the work happens
 * inside the shard, where `ctx.payments` — and its store — exist.
 *
 * The edge forwards the request's headers verbatim rather than one named
 * signature header, so the adapter finds whichever header its provider signs
 * with: `stripe-signature` here, but `creem-signature`, the Standard-Webhooks
 * `webhook-id`/`webhook-timestamp`/`webhook-signature` trio, or `svix-*`
 * elsewhere.
 */
export const processWebhook = internalAction
    .input({ body: v.string(), headers: v.record(v.string(), v.string()) })
    .action(async ({ args: { body, headers }, ctx }): Promise<{ applied: boolean; status: number }> => {
        const request = new Request("https://internal/payment/webhook", {
            body,
            headers,
            method: "POST",
        });
        const response = await ctx.payments.handleWebhook(request);
        const result = (await response.json()) as { applied?: boolean };

        return { applied: result.applied ?? false, status: response.status };
    });
