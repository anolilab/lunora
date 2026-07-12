import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * A single-room chat — the backend behind the Expo mobile/web client.
 *
 * One project-owned table (`messages`) in the default root Durable Object — no
 * sharding, no D1-global, just live queries + optimistic writes, which is all a
 * one-room chat needs. Identity tables (`user`, `session`, `account`,
 * `verification`) are managed by better-auth and live in D1; they are NOT
 * declared here.
 *
 * `authorName` is denormalised onto each message so the client can render the
 * sender without a second lookup. `userId` is authoritative (stamped from
 * `ctx.auth.userId` server-side); `authorName` is the sender's own display name,
 * which the client legitimately knows from its session.
 */
export default defineSchema({
    messages: defineTable({
        authorName: v.string(),
        createdAt: v.number(),
        text: v.string(),
        userId: v.string(),
    }).index("by_created", ["createdAt"]),
});
