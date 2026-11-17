import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    draws: defineTable({ value: v.number() }),
});
