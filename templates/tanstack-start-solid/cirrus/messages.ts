import { mutation, query, v } from "@cirrus/server";

export const list = query({
    args: { channelId: v.string(), limit: v.optional(v.number()) },
    handler: async (_context, args) => {
        return { channelId: args.channelId, limit: args.limit ?? 50, messages: [] };
    },
});

export const send = mutation({
    args: { channelId: v.string(), text: v.string() },
    handler: async (_context, args) => {
        return { channelId: args.channelId, text: args.text };
    },
});
