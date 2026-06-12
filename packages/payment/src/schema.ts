/**
 * Durable tables for the payment sync store, as `defineTable` builders.
 *
 * Spread `paymentTables` into your app's `defineSchema({ ... })`. Money is stored as
 * `(amountMinor: bigint, currency: string)` columns; every row carries a `provider` discriminator
 * so multiple providers can coexist during a migration. Captures and refunds are append-only
 * records linked to a payment, not booleans.
 */
import type { TableDefinition } from "@cirrus/server";
import { defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";

const products = defineTable({
    description: v.optional(v.string()),
    name: v.string(),
    provider: v.string(),
    providerProductId: v.string(),
}).index("by_provider_product", ["provider", "providerProductId"], { unique: true });

const prices = defineTable({
    active: v.boolean(),
    amountMinor: v.bigint(),
    currency: v.string(),
    interval: v.optional(v.string()),
    provider: v.string(),
    providerPriceId: v.string(),
    providerProductId: v.string(),
}).index("by_provider_price", ["provider", "providerPriceId"], { unique: true });

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

const checkouts = defineTable({
    createdAt: v.number(),
    mode: v.string(),
    priceId: v.string(),
    provider: v.string(),
    providerCheckoutId: v.string(),
    referenceId: v.string(),
    url: v.string(),
}).index("by_provider_checkout", ["provider", "providerCheckoutId"], { unique: true });

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

const payments = defineTable({
    amountMinor: v.bigint(),
    createdAt: v.number(),
    currency: v.string(),
    provider: v.string(),
    providerPaymentId: v.string(),
    referenceId: v.string(),
    sessionId: v.string(),
    status: v.string(),
}).index("by_provider_payment", ["provider", "providerPaymentId"], { unique: true });

const captures = defineTable({
    amountMinor: v.bigint(),
    createdAt: v.number(),
    currency: v.string(),
    provider: v.string(),
    providerCaptureId: v.string(),
    sessionId: v.string(),
}).index("by_session", ["sessionId"]);

const refunds = defineTable({
    amountMinor: v.bigint(),
    createdAt: v.number(),
    currency: v.string(),
    provider: v.string(),
    providerRefundId: v.string(),
    reason: v.optional(v.string()),
    sessionId: v.string(),
}).index("by_session", ["sessionId"]);

const invoices = defineTable({
    amountMinor: v.bigint(),
    createdAt: v.number(),
    currency: v.string(),
    provider: v.string(),
    providerInvoiceId: v.string(),
    referenceId: v.string(),
    status: v.string(),
    subscriptionId: v.optional(v.string()),
}).index("by_provider_invoice", ["provider", "providerInvoiceId"], { unique: true });

// Append-only webhook log: inbound idempotency + audit + debugging.
const events = defineTable({
    processedAt: v.number(),
    provider: v.string(),
    providerEventId: v.string(),
    type: v.string(),
}).index("by_provider_event", ["provider", "providerEventId"], { unique: true });

const paymentTables: Record<string, TableDefinition> = {
    captures,
    checkouts,
    customers,
    events,
    invoices,
    paymentSessions,
    payments,
    prices,
    products,
    refunds,
    subscriptions,
};

export default paymentTables;
