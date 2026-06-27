import { RateLimiter, rateLimit } from "@lunora/ratelimit";

import { mutation, query, v } from "#lunora/_generated/server.js";

/**
 * One in-memory limiter so the public `send` mutation isn't an open flood target
 * out of the box. The default store is in-memory (per-isolate, resets on
 * eviction) — fine for a starter; run `lunora add ratelimit` for the durable,
 * `ctx.db`-backed store when you ship to production.
 */
const limiter = new RateLimiter({
    config: {
        send: { kind: "token bucket", period: 60_000, rate: 30 },
    },
});

export const list = query.input({ channelId: v.string().meta({ schema: { maxLength: 256 } }), limit: v.optional(v.number()) }).query(async ({ args, ctx }) => {
    const messages = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
        .take(args.limit ?? 50);

    return { channelId: args.channelId, messages };
});

export const send = mutation
    .input({ channelId: v.string().meta({ schema: { maxLength: 256 } }), text: v.string().meta({ schema: { maxLength: 4096 } }) })
    .use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId ?? "anon" }))
    .mutation(async ({ args, ctx }) => {
        const id = await ctx.db.insert("messages", { channelId: args.channelId, text: args.text });

        return { channelId: args.channelId, id, text: args.text };
    });
