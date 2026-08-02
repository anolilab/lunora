import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * team-chat — channels, live messages, presence, and file uploads.
 *
 * This is the schema the sharding model was designed for, so it uses all three
 * data tiers:
 *
 * - `messages` and `presence` are `.shardBy("channelId")`. A channel is a
 *   Durable Object: sending a message is one serialized commit on one object,
 *   and the poke goes to the sockets subscribed to that channel and nowhere
 *   else. Adding channels adds objects, not contention.
 * - `channels` is root-scoped. It is small, it is read by everyone, and it has
 *   to be listable before you know which channel you want.
 * - `profiles` is `.global()` (D1), because a display name has to resolve from
 *   inside any channel's shard — identity is the canonical cross-shard read.
 *
 * The consequence worth internalising: a query runs inside one shard, so
 * `messages.list` cannot join `profiles`. It returns author ids and the client
 * joins against a single `profiles.list` subscription. That is the trade
 * sharding asks for, and it is cheap — one directory read for a whole session.
 */
export default defineSchema({
    profiles: defineTable({
        userId: v.string(),
        name: v.string(),
        avatarKey: v.optional(v.string()),
    })
        .global()
        .index("by_user", ["userId"], { unique: true }),

    channels: defineTable({
        name: v.string(),
        createdBy: v.string(),
    }).index("by_name", ["name"], { unique: true }),

    messages: defineTable({
        channelId: v.string(),
        authorId: v.string(),
        content: v.string(),
        attachmentKey: v.optional(v.string()),
        attachmentName: v.optional(v.string()),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"])
        .searchIndex("search_content", { field: "content", filterFields: ["channelId"] }),

    /** One row per open tab. `lastSeen` is refreshed by a heartbeat; stale rows are simply not listed. */
    presence: defineTable({
        channelId: v.string(),
        sessionId: v.string(),
        userId: v.string(),
        name: v.string(),
        lastSeen: v.number(),
    })
        .shardBy("channelId")
        .index("by_channel_session", ["channelId", "sessionId"], { unique: true }),
});
