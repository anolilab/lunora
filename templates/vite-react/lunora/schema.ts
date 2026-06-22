import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.string(),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
