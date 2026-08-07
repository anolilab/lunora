import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * payment-demo schema.
 *
 * Codegen discovers tables by parsing THIS file's AST — it cannot resolve a
 * cross-package spread like `defineSchema({ ...paymentTables })`. So the payment
 * tables are declared inline here; `@lunora/payment`'s exported `paymentTables`
 * is the canonical column reference these mirror (and what its store reads/writes).
 *
 * Because they're declared here, an app can also opt read-heavy tables into D1
 * for cross-region low-latency reads by chaining `.global()` (e.g. mark
 * `subscriptions` global) — codegen routes those to `drizzle.global.ts`.
 */
export default defineSchema({
    customers: defineTable({
        createdAt: v.number(),
        email: v.optional(v.string()),
        provider: v.string(),
        providerCustomerId: v.string(),
        referenceId: v.string(),
    })
        .index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true })
        .index("by_reference", ["referenceId"]),

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

    // Metered-usage ledger backing `ctx.payments.track` / `check`.
    usageEvents: defineTable({
        createdAt: v.number(),
        featureId: v.string(),
        idempotencyKey: v.string(),
        // `"add"` (default when absent) or `"set"`: a `"set"` row is an absolute
        // marker the period fold resets to, which is what keeps concurrent
        // `track({ mode: "set" })` calls from double-applying.
        mode: v.optional(v.string()),
        provider: v.string(),
        quantity: v.number(),
        referenceId: v.string(),
        reportedToProvider: v.boolean(),
    })
        .index("by_idempotency", ["provider", "idempotencyKey"], { unique: true })
        .index("by_reference_feature", ["referenceId", "featureId"]),
});
