import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
