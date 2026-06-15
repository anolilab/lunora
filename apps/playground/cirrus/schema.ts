import { defineSchema, defineTable, v } from "@cirrus/server";

/**
 * Cirrus playground schema — wires up every storage tier that ships in v0.1.
 *
 * - `channels` and `users` live in D1 (`.global()`) because they're queried
 *   across tenants in the channel-picker.
 * - `messages` shard by `channelId` so a busy channel scales horizontally
 *   instead of melting the root DO.
 * - `inbox` holds messages received via `@cirrus/mail/inbound` — it lives in the
 *   default root DO (no `.shardBy`/`.global`) to match the inbound dispatcher's
 *   default `__root__` shard key.
 */
export default defineSchema({
    channels: defineTable({
        createdAt: v.number(),
        createdBy: v.id("users"),
        name: v.string(),
    })
        .global()
        .index("by_name", ["name"], { unique: true }),

    inbox: defineTable({
        body: v.string(),
        from: v.string(),
        messageId: v.string(),
        receivedAt: v.number(),
        subject: v.string(),
        to: v.array(v.string()),
    }).index("by_received", ["receivedAt"]),

    messages: defineTable({
        channelId: v.id("channels"),
        createdAt: v.number(),
        text: v.string(),
        userId: v.id("users"),
    })
        .shardBy("channelId")
        .index("by_channel_created", ["channelId", "_creationTime"])
        // Lets the daily cleanup purge stale messages via an indexed range scan
        // (`createdAt < cutoff`) instead of loading every row and filtering in memory.
        .index("by_created", ["createdAt"]),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),
});
