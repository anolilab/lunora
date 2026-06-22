import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * One root-scoped table holding a single shared counter row. No sharding, no
 * auth — the smallest schema that still shows off live subscriptions. Swap this
 * out for your own tables; `pnpm dev` regenerates `_generated/` on save.
 */
export default defineSchema({
    counter: defineTable({
        name: v.string(),
        value: v.number(),
    }).index("by_name", ["name"]),
});
