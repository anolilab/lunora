import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    snapshots: defineTable({ path: v.string(), repo: v.string() }),
});
