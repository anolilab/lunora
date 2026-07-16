/**
 * Durable tables for the payment sync store — the **canonical column reference** for the store's
 * read/write contract.
 *
 * NOTE: codegen discovers tables by parsing your `lunora/schema.ts` AST, so it cannot resolve a
 * cross-package `defineSchema({ ...paymentTables })` spread. Declare these tables **inline** in
 * your own `lunora/schema.ts` (mirroring the columns here) — that also lets you chain `.global()`
 * on read-heavy tables (e.g. `subscriptions`) to serve cross-region reads from D1. See
 * `examples/payment-demo/lunora/schema.ts`.
 *
 * Money is stored as `(amountMinor: bigint, currency: string)` columns; every row carries a
 * `provider` discriminator so multiple providers can coexist during a migration. A refund is folded
 * into its `paymentSessions` row (`refundedMinor` + a `refunded`/`partially_refunded` state), not a
 * separate ledger table.
 *
 * These five tables — `customers`, `subscriptions`, `paymentSessions`, `usageEvents`, and the
 * `events` webhook log — are exactly what the store reads and writes; mirror only these in your app.
 */
import type { TableDefinition } from "@lunora/server";
import { defineTable } from "@lunora/server";
import { v } from "@lunora/values";

const customers = defineTable({
    createdAt: v.number(),
    email: v.optional(v.string()),
    provider: v.string(),
    providerCustomerId: v.string(),
    referenceId: v.string(),
})
    .index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true })
    .index("by_reference", ["referenceId"]);

const subscriptions = defineTable({
    cancelAtPeriodEnd: v.boolean(),
    createdAt: v.number(),
    currentPeriodEnd: v.optional(v.number()),
    currentPeriodStart: v.optional(v.number()),
    priceId: v.string(),
    provider: v.string(),
    providerSubscriptionId: v.string(),
    quantity: v.number(),
    referenceId: v.string(),
    state: v.string(),
    updatedAt: v.number(),
})
    .index("by_provider_subscription", ["provider", "providerSubscriptionId"], { unique: true })
    .index("by_reference", ["referenceId"]);

const paymentSessions = defineTable({
    amountMinor: v.bigint(),
    capturedMinor: v.bigint(),
    createdAt: v.number(),
    currency: v.string(),
    provider: v.string(),
    providerSessionId: v.string(),
    referenceId: v.string(),
    refundedMinor: v.bigint(),
    state: v.string(),
    updatedAt: v.number(),
})
    .index("by_provider_session", ["provider", "providerSessionId"], { unique: true })
    .index("by_reference", ["referenceId"]);

// Append-only webhook log: inbound idempotency + audit + debugging.
const events = defineTable({
    processedAt: v.number(),
    provider: v.string(),
    providerEventId: v.string(),
    type: v.string(),
}).index("by_provider_event", ["provider", "providerEventId"], { unique: true });

// Append-only metered-usage ledger: `track` writes, `check` sums over the current period. The
// unique `by_idempotency` index makes recording exactly-once under concurrent/retried writes.
const usageEvents = defineTable({
    createdAt: v.number(),
    featureId: v.string(),
    idempotencyKey: v.string(),
    provider: v.string(),
    quantity: v.number(),
    referenceId: v.string(),
    reportedToProvider: v.boolean(),
})
    .index("by_idempotency", ["provider", "idempotencyKey"], { unique: true })
    .index("by_reference_feature", ["referenceId", "featureId"]);

/**
 * `paymentTables` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const paymentTables: Record<string, TableDefinition> = {
    customers,
    events,
    paymentSessions,
    subscriptions,
    usageEvents,
};

export default paymentTables;
