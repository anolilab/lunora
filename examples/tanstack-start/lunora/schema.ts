import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * tanstack-start — server-rendered, then live.
 *
 * One root-scoped table, on purpose. A server render reads each query
 * separately, and Lunora has no "read every query at timestamp T" API: what it
 * guarantees is that a single query is a consistent read of its shard at the
 * moment it runs. So when a page must render one coherent picture, the reliable
 * way to get it is to make it *one* query against *one* shard — as
 * `messages.board` does below — rather than to stitch several reads together
 * and hope they agree.
 */
export default defineSchema({
    messages: defineTable({
        author: v.string(),
        body: v.string(),
        postedAt: v.number(),
    }).index("by_posted", ["postedAt"]),
});
