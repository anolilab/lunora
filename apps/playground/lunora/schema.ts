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

    /**
     * A deliberately WIDE, high-volume table for exercising the Studio data
     * browser: column pinning, horizontal column windowing, search-match
     * highlighting, typed date-range search, and reverse-relation counts.
     *
     * 24 columns is past the point where the grid mounts every cell of every
     * visible row, so the windowing is observable rather than theoretical; the
     * `ownerId` / `channelId` refs give the data browser two forward links and
     * give `users` / `channels` two more reverse edges to count.
     *
     * Fill it with `lunora seed --table demoRecords --count 250`: the seeder
     * derives the rows from this definition, seeds the FK parents first, and
     * gives the `*At` columns real timestamps spread over the last six months,
     * which is what makes the grid's `2026-07`-style date search meaningful.
     */
    demoRecords: defineTable({
        amount: v.number(),
        category: v.string(),
        channelId: v.id("channels"),
        city: v.string(),
        code: v.string(),
        country: v.string(),
        createdAt: v.number(),
        currency: v.string(),
        department: v.string(),
        description: v.string(),
        email: v.string(),
        externalRef: v.string(),
        latitude: v.number(),
        longitude: v.number(),
        notes: v.optional(v.string()),
        ownerId: v.id("users"),
        priority: v.number(),
        quantity: v.number(),
        region: v.string(),
        sku: v.string(),
        status: v.string(),
        tags: v.string(),
        title: v.string(),
        updatedAt: v.number(),
    })
        .index("by_created", ["createdAt"])
        .index("by_status", ["status"]),

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
