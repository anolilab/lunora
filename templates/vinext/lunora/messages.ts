import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { MutationCtx } from "#lunora/_generated/server.js";
import { mutation, query, v } from "#lunora/_generated/server.js";

/**
 * The limiter comes from `lunora/ratelimit/schema.ts` — that file owns the named
 * limits and the durable store, so tuning `send` there is what changes this
 * procedure's budget. Build it from the generated `MutationCtx` so
 * `rateLimit(limiter, …)` infers the full procedure context: `ctx.auth`/`ctx.ip`
 * in the key callback and a typed `ctx.db` in the handler both depend on it.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);

/**
 * One bucket per caller, not one bucket for the whole app.
 *
 * `ctx.auth.userId` is `null` until you wire auth (`lunora registry add auth`),
 * so the `ctx.ip` fallback is what actually keys the limit in a fresh project.
 * Keying on `"anon"` alone would let one script exhaust the budget for every user.
 *
 * `ctx.ip` is Cloudflare's server-side `CF-Connecting-IP` and is populated ONLY
 * when the app runs on Cloudflare, where the edge stamps that header over
 * anything the client sent. Deploy this to another target and `ctx.ip` is
 * `undefined` by design — the runtime will not pass on a header the caller can
 * type — so every anonymous caller falls back to the shared `"anon"` bucket.
 * Off Cloudflare, key on something the caller cannot choose (an API key, a
 * signed session) before relying on this limit.
 */
const byCaller = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

export const list = query.input({ channelId: v.string().max(256), limit: v.optional(v.number()) }).query(async ({ args, ctx }) => {
    const messages = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
        .take(args.limit ?? 50);

    return { channelId: args.channelId, messages };
});

export const send = mutation
    .input({ channelId: v.string().max(256), text: v.string().max(4096) })
    .use(rateLimit(limiter, "send", byCaller))
    .mutation(async ({ args, ctx }) => {
        const id = await ctx.db.insert("messages", { channelId: args.channelId, text: args.text });

        return { channelId: args.channelId, id, text: args.text };
    });
