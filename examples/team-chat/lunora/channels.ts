import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * Everyone here is signed in, so limits are keyed by user rather than by IP —
 * one person on a shared network must not be able to exhaust another's budget.
 */
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

/** Root-scoped, so no shard key: this is the list you read before you know which channel you want. */
export const list = query.query(async ({ ctx }): Promise<Doc<"channels">[]> => {
    if (!ctx.auth.userId) {
        return [];
    }

    return ctx.db.query("channels").withIndex("by_name").order("asc").collect();
});

/**
 * Create a channel. The `by_name` index is unique, so the duplicate check below
 * is a friendlier error, not the guarantee — two people creating `#general` at
 * the same moment cannot both win.
 */
export const create = mutation
    .use(rateLimit(mutationLimiter, "send", byUser))
    .input({ name: v.string().max(64) })
    .mutation(async ({ args: { name }, ctx }): Promise<Id<"channels">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to create a channel");
        }

        const slug = name
            .trim()
            .toLowerCase()
            .replaceAll(/[^a-z0-9-]+/gu, "-")
            .replaceAll(/^-+|-+$/gu, "");

        if (!slug) {
            throw new LunoraError("BAD_REQUEST", "channel name must contain a letter or a digit");
        }

        const existing = await ctx.db
            .query("channels")
            .withIndex("by_name", (q) => q.eq("name", slug))
            .first();

        if (existing) {
            throw new LunoraError("CONFLICT", `#${slug} already exists`);
        }

        ctx.log.info("channel created", { name: slug });

        return ctx.db.insert("channels", { createdBy: ctx.auth.userId, name: slug });
    });
