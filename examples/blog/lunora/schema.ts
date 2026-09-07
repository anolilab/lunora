import { ratelimit } from "./ratelimit/schema.js";
import { defineSchema, defineTable, v } from "lunorash/server";

import { EMBED_DIMENSIONS, embedText } from "./embed.js";

/**
 * blog — exercises the Lunora add-on stack.
 *
 * - `posts` and `drafts` are root-scoped: no `.shardBy()`, so every row lives in
 *   the single default ShardDO and its SQLite. That is the right default; reach
 *   for `.shardBy("authorId")` once one DO's write throughput or storage is the
 *   ceiling (see `examples/realtime-cursors` for a sharded table).
 * - `posts.body` is `.vectorize()`d into the `posts_search` index, so every
 *   write keeps Vectorize in sync and `posts.search` can do semantic lookups.
 * - `lunora/crons.ts` runs `cleanup.purgeStaleDrafts` nightly.
 *
 * There is deliberately no `users` table. Identity is better-auth's, and its
 * tables (user, session, account, verification) live in D1 under
 * `lunoraD1Adapter` — declaring a second, hand-rolled credential table here
 * would be a store nothing writes and a foreign key pointing at empty rows.
 * `authorId` therefore holds the better-auth user id as a plain string.
 * For a `.global()` (D1-backed, cross-shard) table with rows in it, see
 * `profiles` in `examples/team-chat`.
 */
export default defineSchema({
    posts: defineTable({
        authorId: v.string(),
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
        authorId: v.string(),
        title: v.string(),
        body: v.string(),
        updatedAt: v.number(),
    })
        // Equality prefix (`authorId`) + sort key (`updatedAt`), so `listMine`
        // reads one author's drafts in order off the index instead of collecting
        // every author's rows and filtering in JS.
        .index("by_author_updated", ["authorId", "updatedAt"])
        .index("by_updated", ["updatedAt"]),
}).extend(ratelimit.extension);
