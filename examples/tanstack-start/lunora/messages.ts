import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/** No sign-in here, so the limit is keyed by caller IP — it is the only identity there is. */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: MutationCtx): string => ctx.ip ?? "anon" };

/** What the page renders: the list and its summary, read together. */
export interface Board {
    messages: Doc<"messages">[];
    /** When the newest message was posted, `0` when there are none. */
    newestAt: number;
    total: number;
}

/**
 * The whole page in one query.
 *
 * Splitting this into `list` + `stats` would mean two reads, and nothing ties
 * them to the same instant — the summary could come from after a write the list
 * missed. One handler, one read of one shard, one coherent answer. That is the
 * shape SSR wants, and the same query then drives the live subscription after
 * hydration.
 *
 * Note there is no `Date.now()` in here. A live query is re-evaluated whenever
 * the shard pokes it, so a wall-clock value would change on every push and churn
 * every subscriber. Everything a query returns should be a function of the data.
 */
export const board = query.input({ limit: v.optional(v.number()) }).query(async ({ args: { limit }, ctx }): Promise<Board> => {
    const messages = await ctx.db
        .query("messages")
        .withIndex("by_posted")
        .order("desc")
        .take(Math.min(Math.max(limit ?? 50, 1), 200));

    return { messages, newestAt: messages[0]?.postedAt ?? 0, total: messages.length };
});

export const send = mutation
    .use(rateLimit(limiter, "send", byCaller))
    .input({ author: v.string().max(80), body: v.string().max(140) })
    .mutation(async ({ args: { author, body }, ctx }): Promise<Id<"messages">> => {
        const id = await ctx.db.insert("messages", { author, body, postedAt: Date.now() });

        ctx.log.info("message posted", { author, id });

        return id;
    });
