import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * kanban-board — one board, four columns, drag-and-drop reordering.
 *
 * The table is root-scoped (no `.shardBy`), so the whole board lives in a
 * single ShardDO: every card read and every reorder is one SQLite transaction
 * on one object, and every connected browser subscribes to the same stream of
 * deltas. A board is exactly the unit of consistency you want in one shard —
 * reach for `.shardBy` once boards become independent of one another.
 *
 * `order` is a fractional index key rather than a position integer. See
 * `ordering.ts` for why.
 *
 * The `status` union is written out here rather than imported from a shared
 * const: codegen reads column validators syntactically, and an identifier it
 * has to follow degrades the generated column type to `unknown`.
 */
export default defineSchema({
    tasks: defineTable({
        title: v.string(),
        status: v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived")),
        order: v.string(),
    }).index("by_status_and_order", ["status", "order"]),
});
