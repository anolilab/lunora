import { defineSchema, defineTable, v } from "@lunora/server";

// A minimal app schema. (A real agent app also `.extend(agentExtension)` to add
// the thread tables; that is orthogonal to the sandbox wiring exercised here.)
export const schema = defineSchema({
    notes: defineTable({
        body: v.string(),
        title: v.string(),
    }).index("by_title", ["title"]),
});
