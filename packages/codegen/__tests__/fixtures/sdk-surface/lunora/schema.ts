import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    items: defineTable({ title: v.string() }),
});
