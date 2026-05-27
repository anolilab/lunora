import { defineSchema, defineTable, v } from "@cirrus/server";

/**
 * todo-app — the simplest CRUD demo.
 *
 * Everything fits in a single root-scoped table; no global D1 reads, no
 * sharding, no auth. A great place to start when learning Cirrus.
 */
export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
