import { defineSchema, defineTable, v } from "@cirrus/server";

/**
 * blog — exercises the full Cirrus add-on stack.
 *
 * - `users` is `.global()` so signin lookups hit D1 and one identity can
 *   span tenants/shards.
 * - `posts` and `drafts` are root-scoped: they live in the per-author
 *   ShardDO, which keeps writes local and SQLite-fast.
 * - The scheduled cron in `cleanup.ts` purges stale drafts every night.
 */
export default defineSchema({
    users: defineTable({
        email: v.string(),
        name: v.string(),
        passwordHash: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),

    posts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
        body: v.string(),
        imageKey: v.optional(v.string()),
        publishedAt: v.number(),
    }).index("by_published", ["publishedAt"]),

    drafts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
        body: v.string(),
        updatedAt: v.number(),
    }).index("by_updated", ["updatedAt"]),
});
