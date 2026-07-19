import { RateLimiter, rateLimit, createDbStore } from "lunorash/ratelimit";

import type { MutationCtx } from "#lunora/_generated/server.js";
import { mutation, query, v } from "#lunora/_generated/server.js";

// Typed against the generated MutationCtx so `rateLimit(limiter, ...)` infers
// the full procedure context — `ctx.auth` in the key callback and a typed
// `ctx.db` in the downstream handler both depend on it.
const limiter = (ctx: MutationCtx) =>
    new RateLimiter({
        config: {
            send: { kind: "token bucket", period: 60_000, rate: 30 },
        },
        store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }),
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
