import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * Lunora playground schema — wires up every storage tier that ships in v0.1.
 *
 * - `channels` and `users` live in D1 (`.global()`) because they're queried
 *   across tenants in the channel-picker.
 * - `messages` shard by `channelId` so a busy channel scales horizontally
 *   instead of melting the root DO.
 * - `inbox` holds messages received via `@lunora/mail/inbound` — it lives in the
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

    // Backing table for `@lunora/ratelimit`'s `createDbStore` — one row per
    // `(limit, key)` bucket, looked up by the opaque storage key. Written only by
    // the rate-limit middleware (via `ctx.db`), never by a hand-written mutation —
    // `.externallyManaged()` tells the advisor not to flag the absent insert path.
    rateLimits: defineTable({
        key: v.string(),
        prev: v.optional(v.number()),
        ts: v.number(),
        value: v.number(),
    })
        .externallyManaged()
        .index("by_key", ["key"]),

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

    // Per-user private notes — the playground's Row-Level Security surface.
    // Lives in the default root DO; `notes.list` deliberately reads the WHOLE
    // table and relies on the `rls()` read policy (see lunora/notes.ts) to
    // narrow it to the caller's rows, so the auth-rls E2E proves the policy —
    // not a hand-written filter — is what isolates users.
    notes: defineTable({
        createdAt: v.number(),
        ownerId: v.id("users"),
        text: v.string(),
    }).index("by_owner", ["ownerId"]),

    // Mirror of the better-auth user rows (id + display name), owned by
    // `@lunora/auth`'s adapter rather than a hand-written mutation — hence
    // `.externallyManaged()`.
    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .externallyManaged()
        .global()
        .index("by_email", ["email"], { unique: true }),
});
