import { defineSchema, defineTable, v } from "@cirrus/server";

import { EMBED_DIMENSIONS, embedText } from "./embed.js";

/**
 * blog — exercises the full Cirrus add-on stack.
 *
 * - `users` is `.global()` so signin lookups hit D1 and one identity can
 *   span tenants/shards.
 * - `posts` and `drafts` are root-scoped: they live in the per-author
 *   ShardDO, which keeps writes local and SQLite-fast.
 * - `posts.body` is `.vectorize()`d into the `posts_search` index, so every
 *   write keeps Vectorize in sync and `posts.search` can do semantic lookups.
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
    })
        .index("by_published", ["publishedAt"])
        .vectorize("body", {
            dimensions: EMBED_DIMENSIONS,
            embed: embedText,
            index: "posts_search",
            metadata: ["title"],
            metric: "cosine",
        }),

    drafts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
        body: v.string(),
        updatedAt: v.number(),
    }).index("by_updated", ["updatedAt"]),
});
