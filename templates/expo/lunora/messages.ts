import { LunoraError } from "lunorash/server";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * Everyone posting here is signed in, so the limit keys on the user — one
 * account cannot exhaust another's budget, and `ctx.ip` is only the fallback for
 * a request that somehow reached the handler without a resolved session. Never
 * key on a value out of `args`: a caller can rotate that per request and never
 * share a bucket with themselves. Limits themselves live in
 * `lunora/ratelimit/schema.ts`.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

interface MessageRow {
    _id: Id<"messages">;
    authorName: string;
    createdAt: number;
    text: string;
    userId: string;
}

/** How many messages the chat screen keeps live. */
const PAGE_SIZE = 100;

/**
 * `ctx.auth.userId` is populated by Lunora's runtime from the resolved
 * better-auth session — see `src/server/index.ts` for the `resolveIdentity`
 * wiring. A `null` userId means the caller is anonymous.
 */
const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "sign in to use the chat");
    }

    return userId;
};

/**
 * The most recent messages, oldest-first (chat order). Every signed-in client
 * that calls this over the WebSocket receives deltas the instant `send` writes a
 * new row — no polling, no manual refetch.
 */
export const list = query.query(async ({ ctx }): Promise<MessageRow[]> => {
    assertSignedIn(ctx.auth.userId);

    // Read the newest PAGE_SIZE rows straight off the `by_created` index
    // (descending), then reverse to oldest-first for chat order — never scans
    // past the page we keep.
    const rows = await ctx.db.query("messages").withIndex("by_created").order("desc").take(PAGE_SIZE);

    return rows.reverse();
});

/**
 * Post a message. `userId` is stamped from the authenticated session (never
 * trusted from the client); `authorName` is the sender's own display name. Both
 * text inputs are length-bounded so a client can't submit an arbitrarily large
 * payload.
 */
export const send = mutation
    .input({
        authorName: v.string().max(256),
        text: v.string().max(4096),
    })
    .use(rateLimit(limiter, "send", byUser))
    .mutation(async ({ args: { authorName, text }, ctx }): Promise<Id<"messages">> => {
        const userId = assertSignedIn(ctx.auth.userId);
        const trimmed = text.trim();

        if (trimmed === "") {
            throw new LunoraError("BAD_REQUEST", "message text is empty");
        }

        return ctx.db.insert("messages", {
            authorName,
            createdAt: Date.now(),
            text: trimmed,
            userId,
        });
    });
