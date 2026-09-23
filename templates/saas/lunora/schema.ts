// lunora:add:presence:start
import { presence } from "./presence/schema";
// lunora:add:presence:end
// lunora:add:saas:start
import { saas } from "./saas/schema";
// lunora:add:saas:end
// lunora:add:ratelimit:start
import { ratelimit } from "./ratelimit/schema";
// lunora:add:ratelimit:end
import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * Your tables go in the `defineSchema({ … })` call; the kit's arrive through the
 * managed `.extend()` blocks below, which `lunora registry add` maintains.
 *
 * The default export is load-bearing — codegen's generated `app.ts` and
 * `shard.ts` import this module's default.
 */
export default defineSchema({
    /*
     * The payment store's tables, declared INLINE and UNPREFIXED because that is
     * what works: codegen parses this file as an AST, so a spread is silently
     * skipped, and a `.extend()` merge would prefix names the store reads bare.
     *
     * They are root-scoped rather than `.shardBy("referenceId")`, and that is a
     * deliberate asymmetry with the rest of this app. A provider webhook arrives
     * with no session and no tenant — there is nothing to resolve a shard from —
     * so billing rows live at the root and carry the tenant in `referenceId`
     * instead. The organization id goes in that field (see `lunora/server.ts`),
     * which is what keeps a subscription tenant-scoped logically even though it
     * is not tenant-sharded physically.
     */
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
})
    // lunora:add:ratelimit:start
    .extend(ratelimit.extension)
    // lunora:add:ratelimit:end
    // lunora:add:saas:start
    .extend(saas.extension)
    // lunora:add:presence:start
    .extend(presence.extension);
// lunora:add:presence:end
// lunora:add:saas:end
