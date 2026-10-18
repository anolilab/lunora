import { defineSchema, defineTable, v } from "@lunora/server";

// A default export, like every template: the generated `shard.ts` imports it as
// `import schema from "../schema.js"`.
export default defineSchema({
    notes: defineTable({ text: v.string() }),
});
