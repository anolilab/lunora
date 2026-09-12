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
import type { SubscriptionState } from "@lunora/payment";
import { action, internalAction, query, v } from "#lunora/_generated/server.js";

import { SUBSCRIPTIONS_TABLE } from "./schema.js";

/**
 * Public origin of this deployment, used to build the checkout return URLs and
 * the billing-portal return URL. Read from env rather than the request: a Lunora
 * context carries no `Request` (a mutation can be replayed, a query re-run from
 * a live subscription), so there is nothing to derive an origin from at handler
 * time.
 *
 * `APP_BASE_URL` is declared BOTH as a wrangler `vars` entry (by this item's
 * manifest) and in `.dev.vars`. The first is what puts it on the generated env
 * TYPE — `CloudflareBindings` is built from wrangler's config, so a var that
 * lives only in `.dev.vars` reaches the running Worker and not the
 * type-checker, and reading it here is a `TS7053`. The second supplies the value
 * locally, and wins over `vars` under `wrangler dev`.
 *
 * The manifest ships the `vars` entry EMPTY. `vars` is deployed configuration,
 * so a committed `http://localhost:…` placeholder is read only in production —
 * where it is wrong — and the throw below could never fire: `checkout` would
 * succeed and hand Stripe a `success_url` on the customer's own machine. Empty
 * keeps the failure loud and local to the deploy, not to a paying customer's
 * browser.
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

/*
 * Column readers for the raw `subscriptions` row. `ctx.db` hands back
 * `Record<string, unknown>`, and a bare `row["x"] as string` types a MISSING
 * column as `string` while handing the client `undefined` — so a row written
 * before a column existed reaches a screen as a non-string claiming to be one.
 * These narrow instead of asserting, and an absent optional column reads back as
 * `null` (not `undefined`) through the shard, which the `typeof` tests handle.
 */
const readString = (row: Record<string, unknown>, column: string): string => (typeof row[column] === "string" ? (row[column] as string) : "");

const readOptionalNumber = (row: Record<string, unknown>, column: string): number | undefined =>
    typeof row[column] === "number" ? (row[column] as number) : undefined;

const readOptionalStringArray = (row: Record<string, unknown>, column: string): string[] | undefined => {
    const value = row[column];

    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
};

/**
 * What a billing screen reads. A hand-rolled projection rather than
 * `@lunora/payment`'s `Subscription` because this is a `query` and the canonical
 * decoder sits behind `ctx.payments`, which is ActionCtx-only — so the field set
 * here has to be kept in step with `packages/payment/src/schema.ts` by hand.
 */
interface SubscriptionRow {
    /** Outranks `state` in the UI: a subscription can be `active` AND ending. */
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd?: number;
    /** Start of the billing period metered usage is summed over. Without it a client falls back to `createdAt` and shows LIFETIME usage against a per-period limit. */
    currentPeriodStart?: number;
    /** The PRIMARY price id — `priceIds[0]`. For display; match plans against `priceIds`. */
    priceId: string;

    /**
     * EVERY price id the subscription bills. This — not `priceId` — is what a plan
     * lookup tests membership in, mirroring `hasActivePrice`: a Stripe subscription
     * is a list of items, so a base plan alongside an add-on or a metered price has
     * a `priceId` naming only one of them.
     *
     * Absent on rows written by the webhook path (which carries one price id);
     * read it as `priceIds ?? [priceId]`.
     */
    priceIds?: string[];
    /** Which provider's row this is. Load-bearing while two providers coexist during a migration. */
    provider: string;
    providerSubscriptionId: string;
    /** Seats BILLED — which lags an invite by however long a webhook takes. Count members for display. */
    quantity: number;
    referenceId: string;
    state: SubscriptionState;
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
        cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true,
        currentPeriodEnd: readOptionalNumber(row, "currentPeriodEnd"),
        currentPeriodStart: readOptionalNumber(row, "currentPeriodStart"),
        priceId: readString(row, "priceId"),
        priceIds: readOptionalStringArray(row, "priceIds"),
        provider: readString(row, "provider"),
        providerSubscriptionId: readString(row, "providerSubscriptionId"),
        quantity: typeof row["quantity"] === "number" ? row["quantity"] : 0,
        referenceId: readString(row, "referenceId"),
        state: readString(row, "state") as SubscriptionState,
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
