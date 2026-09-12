import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * The limiter comes from `lunora/ratelimit/schema.ts`, which owns the named
 * limits and the durable store — tuning `write` there is what changes the
 * budget of every mutation below.
 *
 * This app has no sign-in, so `ctx.auth.userId` is always `null` and `ctx.ip`
 * is what actually keys the bucket. `ctx.ip` is Cloudflare's server-side
 * `CF-Connecting-IP`, populated only when the app runs on Cloudflare; anywhere
 * else every caller shares the one `"anon"` bucket, so key on something the
 * caller cannot choose before relying on this limit off Cloudflare.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

interface TodoDoc {
    _id: Id<"todos">;
    createdAt: number;
    done: boolean;
    text: string;
}

/**
 * List todos newest-first. Subscribers receive deltas the moment any of
 * `add` / `toggle` / `remove` mutate the table.
 */
export const list = query.query(async ({ ctx }): Promise<TodoDoc[]> => {
    const rows = await ctx.db.query("todos").withIndex("by_creation").collect();

    return [...rows].sort((a, b) => b.createdAt - a.createdAt);
});

export const add = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ text: v.string().max(4096) })
    .mutation(async ({ args: { text }, ctx }): Promise<Id<"todos">> => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }));

export const toggle = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("todos"), done: v.boolean() })
    .mutation(async ({ args: { id, done }, ctx }): Promise<void> => {
        await ctx.db.patch(id, { done });
    });

export const remove = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("todos") })
    .mutation(async ({ args: { id }, ctx }): Promise<void> => {
        await ctx.db.delete(id);
    });
