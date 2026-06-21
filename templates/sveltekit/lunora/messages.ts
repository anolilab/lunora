import { mutation, query, v } from "./_generated/server.js";

export const list = query.input({ channelId: v.string(), limit: v.optional(v.number()) }).query(async ({ args }) => {
    return { channelId: args.channelId, limit: args.limit ?? 50, messages: [] };
});

export const send = mutation.input({ channelId: v.string(), text: v.string() }).mutation(async ({ args }) => {
    return { channelId: args.channelId, text: args.text };
});
