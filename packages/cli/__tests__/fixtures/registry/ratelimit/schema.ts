import { defineSchemaExtension, defineTable, v } from "@lunora/server";

export const ratelimit = {
    extension: defineSchemaExtension("ratelimit", {
        tables: {
            buckets: defineTable({
                key: v.string(),
                tokens: v.number(),
                updatedAt: v.number(),
            }).index("by_key", ["key"]),
        },
    }),
};
