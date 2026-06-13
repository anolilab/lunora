import { paymentTables } from "@cirrus/payment";
import { defineSchema } from "@cirrus/server";

/**
 * payment-demo — Stripe checkout + webhook-synced subscriptions.
 *
 * `paymentTables` (customers, subscriptions, payments, invoices, the webhook
 * `events` log, …) are spread straight into the app schema, so payment state
 * lives in the app's ShardDO alongside everything else and is queried with the
 * same reactive `ctx.db`. No separate payment Durable Object.
 */
export default defineSchema({
    ...paymentTables,
});
