import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * notify-demo — the end-to-end `@lunora/notify` push wiring.
 *
 * The device subscriptions themselves live in the `@lunora/notify`
 * `d1SubscriptionStore` (its own lazily-created D1 table), so the schema only
 * needs a small `announcements` log recording each broadcast the action fires —
 * enough to demonstrate a real, subscribable table alongside the push flow.
 */
export default defineSchema({
    announcements: defineTable({
        body: v.string(),
        sentAt: v.number(),
        title: v.string(),
    }).index("by_sent", ["sentAt"]),
});
