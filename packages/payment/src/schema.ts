/**
 * The payment store's tables, shipped as a schema extension. An app merges them with one call:
 *
 * ```ts
 * // lunora/schema.ts
 * export default defineSchema({ ... }).extend(paymentExtension);
 * ```
 *
 * Codegen resolves the extension from the installed package, so a column or index added here
 * reaches an app by upgrading `@lunora/payment` — no schema edit. Tables are namespaced with the
 * `payment` key (`payment_customers`, `payment_events`, `payment_sessions`, `payment_subscriptions`,
 * `payment_usageEvents`), the names `PAYMENT_TABLES` in `./database-store` reads and writes.
 *
 * Money is stored as `(amountMinor: number, currency: string)` columns. A double holds every
 * integer up to 2^53 exactly — about 90 trillion dollars in cents — and the row codec in
 * `./database-store` refuses any amount that is not a safe integer, so nothing is ever rounded. A
 * number column, unlike a `v.bigint()` one, is also accepted on a `.global()` table and compares
 * numerically there. Every row carries a
 * `provider` discriminator so multiple providers can coexist during a migration. A refund is folded
 * into its `sessions` row (`refundedMinor` + a `refunded`/`partially_refunded` state), not a separate
 * ledger table.
 */
import type { SchemaExtension, TableDefinition } from "@lunora/server";
import { defineSchemaExtension, defineTable } from "@lunora/server";
import { v } from "@lunora/values";

const customers = defineTable({
    createdAt: v.number(),
    email: v.optional(v.string()),
    provider: v.string(),
    providerCustomerId: v.string(),
    referenceId: v.string(),
})
    .index("by_provider_customer", ["provider", "providerCustomerId"], { unique: true })
    // Not unique: one reference may legitimately hold a customer per provider (Stripe AND Polar).
    // `upsertCustomer` MATCHES on `(provider, referenceId)`, so the steady state is one row per pair
    // and a re-mint updates in place — but that is a convergence property, not an invariant: the
    // match is a non-atomic find-then-insert, so two concurrent first-checkouts for one reference can
    // still both insert. The reader (`getCustomerByReference`) takes the first match, and the next
    // upsert collapses the pair back onto one row.
    .index("by_reference", ["referenceId"]);

const subscriptions = defineTable({
    cancelAtPeriodEnd: v.boolean(),
    createdAt: v.number(),
    currentPeriodEnd: v.optional(v.number()),
    currentPeriodStart: v.optional(v.number()),
    // Provider time of the newest webhook applied — an older redelivery is ignored as stale.
    lastEventAt: v.optional(v.number()),
    priceId: v.string(),

    /**
     * Every price/product id the subscription bills — a Stripe subscription is a list of items, and a
     * base plan alongside an add-on or a metered price is ordinary. `priceId` stays the primary one.
     *
     * OPTIONAL, so adding it needs no backfill: a row written before this column (or by the webhook
     * path, which carries one price id) reads as absent and falls back to `[priceId]`.
     */
    priceIds: v.optional(v.array(v.string())),
    provider: v.string(),
    providerSubscriptionId: v.string(),
    quantity: v.number(),
    referenceId: v.string(),
    state: v.string(),
    updatedAt: v.number(),
})
    .index("by_provider_subscription", ["provider", "providerSubscriptionId"], { unique: true })
    .index("by_reference", ["referenceId"]);

const sessions = defineTable({
    amountMinor: v.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    capturedMinor: v.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    createdAt: v.number(),
    currency: v.string(),
    provider: v.string(),
    providerSessionId: v.string(),
    referenceId: v.string(),
    refundedMinor: v.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    state: v.string(),
    // The provider subscription this payment started — lends its owner to an unattributed subscription row.
    subscriptionId: v.optional(v.string()),
    updatedAt: v.number(),
})
    .index("by_provider_session", ["provider", "providerSessionId"], { unique: true })
    .index("by_provider_subscription", ["provider", "subscriptionId"])
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
    /** `"add"` (default when absent, incl. rows predating this column) or `"set"` — see `UsageEvent.mode`. */
    mode: v.optional(v.string()),
    provider: v.string(),
    quantity: v.number(),
    referenceId: v.string(),
    reportedToProvider: v.boolean(),
})
    .index("by_idempotency", ["provider", "idempotencyKey"], { unique: true })
    .index("by_reference_feature_created", ["referenceId", "featureId", "createdAt"])
    .index("by_reference_created", ["referenceId", "createdAt"]);

// The table names and key stay literal so `.extend(paymentExtension)` adds exactly
// `payment_customers | … | payment_usageEvents`; row types come from codegen.
const paymentExtension: SchemaExtension<
    Record<"customers" | "events" | "sessions" | "subscriptions" | "usageEvents", TableDefinition>,
    "payment"
> = defineSchemaExtension("payment", {
    tables: { customers, events, sessions, subscriptions, usageEvents },
});

export default paymentExtension;
