import { defineSchema, defineTable, v } from "lunora/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.string(),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
