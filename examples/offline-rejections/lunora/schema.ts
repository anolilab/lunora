import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * offline-rejections — a demo of surfacing rejected offline writes.
 *
 * A single root-scoped `messages` table. The interesting part isn't the schema;
 * it's that the `send` mutation deterministically *rejects* some inputs (see
 * `lunora/messages.ts`), so you can watch how a rolled-back optimistic write is
 * surfaced to the UI — including after a reload, when the original mutation
 * Promise is gone and only `client.onMutationSettled` can report it.
 */
export default defineSchema({
    messages: defineTable({
        text: v.string(),
        author: v.string(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
