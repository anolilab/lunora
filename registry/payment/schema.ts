/**
 * Payment tables — copied to `lunora/payment/schema.ts` by `lunora add payment`.
 *
 * **These five tables must be declared in your OWN `lunora/schema.ts`, inline.**
 * Copy the block below into your `defineSchema({ … })` call. That is not a style
 * preference, it is what works:
 *
 *   - Codegen discovers tables by parsing `lunora/schema.ts` as an AST. A spread
 *     (`defineSchema({ ...paymentTables })`) is not a property assignment, so it
 *     is silently skipped and you get a schema with zero payment tables.
 *   - The `.extend(plugin.extension)` route auto-prefixes extension tables with
 *     the plugin key (`payment_subscriptions`), and `@lunora/payment`'s store
 *     reads the bare names (`subscriptions`, `customers`, …) — so a prefixed
 *     merge would leave `ctx.payments` reading tables that don't exist.
 *
 * Without them, the first `ctx.payments.*` call — and `mySubscriptions` — fails
 * with `UNKNOWN_TABLE`.
 *
 * Declaring them inline also lets you chain `.global()` on read-heavy tables
 * (e.g. `subscriptions`) so cross-region reads are served from D1.
 *
 * The columns mirror `@lunora/payment`'s exported `paymentTables`, which is the
 * canonical reference for what the store reads and writes. Money is stored as
 * `(amountMinor: bigint, currency: string)`; every row carries a `provider`
 * discriminator so two providers can coexist during a migration.
 */
import { defineTable, v } from "@lunora/server";

/**
 * The payment store's tables. Exported as a value so a test or migration check
 * can read the column reference — **not** to spread into `defineSchema` (see the
 * module docstring). Copy the declarations into `lunora/schema.ts` verbatim.
 */
export const paymentTables = {
    customers: defineTable({
        createdAt: v.number(),
        email: v.optional(v.string()),
        provider: v.string(),
        providerCustomerId: v.string(),
        referenceId: v.string(),
    })
        .index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true })
        .index("by_reference", ["referenceId"]),

    // Append-only webhook log: inbound idempotency + audit + debugging.
    events: defineTable({
        processedAt: v.number(),
        provider: v.string(),
        providerEventId: v.string(),
        type: v.string(),
    }).index("by_provider_event", ["provider", "providerEventId"], { unique: true }),

    paymentSessions: defineTable({
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
        .index("by_reference", ["referenceId"]),

    subscriptions: defineTable({
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
        .index("by_reference", ["referenceId"]),

    // Append-only metered-usage ledger: `track` writes, `check` sums over the
    // current period. The unique `by_idempotency` index is what makes recording
    // exactly-once under concurrent/retried writes.
    usageEvents: defineTable({
        createdAt: v.number(),
        featureId: v.string(),
        idempotencyKey: v.string(),
        /** `"add"` (default when absent) or `"set"` — an absolute marker the period fold resets to. */
        mode: v.optional(v.string()),
        provider: v.string(),
        quantity: v.number(),
        referenceId: v.string(),
        reportedToProvider: v.boolean(),
    })
        .index("by_idempotency", ["provider", "idempotencyKey"], { unique: true })
        .index("by_reference_feature", ["referenceId", "featureId"]),
};

/** The `subscriptions` table name, referenced by `mySubscriptions` in `./index.ts`. */
export const SUBSCRIPTIONS_TABLE = "subscriptions";
