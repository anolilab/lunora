import { rateLimit } from "lunorash/ratelimit";
import { LunoraError } from "lunorash/server";

import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

const BFAIL_B_RE = /\bfail\b/i;

/**
 * The limiter comes from `lunora/ratelimit/schema.ts`, which owns the named
 * limit and the durable store — and explains why `send`'s budget is generous.
 *
 * No sign-in here, so `ctx.ip` keys the bucket. Never key on `args.author`: the
 * client types that value and can change it per request, so it would never
 * share a bucket with itself. `ctx.ip` is Cloudflare's server-side
 * `CF-Connecting-IP` and is `undefined` off Cloudflare, where every caller then
 * shares the one `"anon"` bucket.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: { ip?: string }): string => ctx.ip ?? "anon" };

interface MessageDocument {
    _id: Id<"messages">;
    author: string;
    createdAt: number;
    text: string;
}

/**
 * List messages newest-first. Subscribers receive deltas the moment `send`
 * commits a new row.
 */
export const list = query.query(async ({ ctx }): Promise<MessageDocument[]> => {
    const rows = await ctx.db.query("messages").withIndex("by_creation").collect();

    return rows.toSorted((a, b) => b.createdAt - a.createdAt);
});

/**
 * Persist a message — but reject some inputs *deterministically* so the demo can
 * reproduce a rejected optimistic write on demand:
 *
 * - any message containing the word "fail" → a coded `CONFLICT`,
 * - an empty message → a coded `BAD_REQUEST`.
 *
 * Throwing a {@link LunoraError} yields a coded `{ error: { code, message } }`
 * envelope; the client treats a *coded* rejection as a terminal verdict (it
 * drops the queued write rather than retrying) and surfaces it on
 * `onMutationSettled` / the rejected `mutation()` Promise.
 */
export const send = mutation
    .use(rateLimit(limiter, "send", byCaller))
    .input({ text: v.string().max(4096), author: v.string().max(80) })
    .mutation(async ({ args: { text, author }, ctx }): Promise<Id<"messages">> => {
        const trimmed = text.trim();

        if (trimmed === "") {
            throw new LunoraError("BAD_REQUEST", "message text cannot be empty");
        }

        if (BFAIL_B_RE.test(trimmed)) {
            throw new LunoraError("CONFLICT", `the server refused to save "${trimmed}"`);
        }

        return ctx.db.insert("messages", { text: trimmed, author, createdAt: Date.now() });
    });
