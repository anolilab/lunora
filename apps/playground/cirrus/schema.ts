import { defineSchema, defineTable, v } from "@cirrus/server";

/**
 * Cirrus playground schema — wires up every storage tier that ships in v0.1.
 *
 * - `channels` and `users` live in D1 (`.global()`) because they're queried
 *   across tenants in the channel-picker.
 * - `messages` shard by `channelId` so a busy channel scales horizontally
 *   instead of melting the root DO.
 */
export default defineSchema({
    channels: defineTable({
        createdAt: v.number(),
        createdBy: v.id("users"),
        name: v.string(),
    })
        .global()
        .index("by_name", ["name"], { unique: true }),

    messages: defineTable({
        channelId: v.id("channels"),
        createdAt: v.number(),
        text: v.string(),
        userId: v.id("users"),
    })
        .shardBy("channelId")
        .index("by_channel_created", ["channelId", "_creationTime"]),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),
});
