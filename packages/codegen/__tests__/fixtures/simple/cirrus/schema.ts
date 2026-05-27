import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"])
        .searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),

    users: defineTable({
        email: v.string(),
        name: v.string(),
        role: v.literal("admin"),
        prefs: v.record(v.string(), v.string()),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),

    // Coverage table — exercises the drizzle emitter's optional/array/bigint/bytes
    // branches. Not used by any function; the codegen tests just assert that the
    // emitted columns match the expected drizzle shapes.
    attachments: defineTable({
        bytes: v.bytes(),
        ownerId: v.id("users"),
        size: v.bigint(),
        tags: v.array(v.string()),
        title: v.optional(v.string()),
    }).global(),
});
