import { mutation, query, v } from "@cirrus/server";

export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (_context, args) => {
        return { channelId: args.channelId, limit: args.limit ?? 50 };
    },
});

export const send = mutation({
    args: {
        channelId: v.id("channels"),
        text: v.string(),
        kind: v.union(v.literal("text"), v.literal("image")),
        tags: v.record(v.string(), v.string()),
    },
    handler: async (_context, args) => {
        return { channelId: args.channelId, text: args.text, kind: args.kind, tags: args.tags };
    },
});
