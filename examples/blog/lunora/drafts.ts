import { LunoraError } from "lunorash/server";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * Writers are signed in, so limits key on the user; `ctx.ip` is the fallback for
 * a request that reached the handler without a resolved session. Never a value
 * out of `args` — the caller could rotate it and never share a bucket.
 */
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

interface DraftDoc {
    _id: Id<"drafts">;
    authorId: string;
    body: string;
    title: string;
    updatedAt: number;
}

/**
 * List the signed-in user's autosaved drafts, most recently edited first.
 *
 * The `by_author_updated` index pins the row set to this author and supplies the
 * ordering, so the handler never sees another author's rows — collecting every
 * draft in the table and filtering in JS both leaks work and grows with the
 * whole app rather than with one user's drafts.
 */
export const listMine = query.query(async ({ ctx }): Promise<DraftDoc[]> => {
    if (!ctx.auth.userId) {
        return [];
    }

    const userId = ctx.auth.userId;

    return ctx.db
        .query("drafts")
        .withIndex("by_author_updated", (range) => range.eq("authorId", userId))
        .order("desc")
        .collect();
});

/**
 * Autosave a draft. Clients call this on every keystroke (debounced) so users
 * never lose work — `cleanup.purgeStaleDrafts` sweeps anything older than 30
 * days.
 *
 * Updating an existing draft re-reads it and checks `authorId` first: `id` comes
 * from the client, so without that check any signed-in user could overwrite
 * anyone else's draft by guessing an id.
 */
export const save = mutation
    .input({
        id: v.optional(v.id("drafts")),
        title: v.string().max(256),
        body: v.string().max(100_000),
    })
    .use(rateLimit(mutationLimiter, "autosave", byUser))
    .mutation(async ({ args: { id, title, body }, ctx }): Promise<Id<"drafts">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHORIZED", "sign in to save a draft");
        }

        const userId = ctx.auth.userId;

        if (id) {
            const existing = await ctx.db.get(id);

            // Same response for "gone" and "someone else's", so the endpoint
            // can't be used to probe which draft ids exist.
            if (!existing || existing.authorId !== userId) {
                throw new LunoraError("NOT_FOUND", "draft not found");
            }

            await ctx.db.patch(id, { title, body, updatedAt: Date.now() });

            return id;
        }

        return ctx.db.insert("drafts", { authorId: userId, title, body, updatedAt: Date.now() });
    });
