import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * This board has no sign-in, so a deployed instance is reachable by anyone and
 * the limit is the only thing between it and a script. Keyed by caller IP —
 * there is no user identity to key on.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: MutationCtx): string => ctx.ip ?? "anon" };

const feedbackStatus = v.union(
    v.literal("open"),
    v.literal("under-review"),
    v.literal("planned"),
    v.literal("in-progress"),
    v.literal("completed"),
    v.literal("closed"),
);

/**
 * The board. `status` narrows through the `by_status` index; `sortBy` picks the
 * ordering. Sorting by votes reads the `by_upvotes` index rather than sorting in
 * JS, so the ordering is the database's job and stays right as the board grows.
 */
export const list = query
    .input({ status: v.optional(feedbackStatus), sortBy: v.optional(v.union(v.literal("votes"), v.literal("recent"))) })
    .query(async ({ args: { sortBy, status }, ctx }): Promise<Doc<"feedback">[]> => {
        if (status) {
            const rows = await ctx.db
                .query("feedback")
                .withIndex("by_status", (q) => q.eq("status", status))
                .collect();

            return sortBy === "votes" ? [...rows].sort((a, b) => b.upvoteCount - a.upvoteCount) : [...rows].sort((a, b) => b._creationTime - a._creationTime);
        }

        if (sortBy === "votes") {
            return ctx.db.query("feedback").withIndex("by_upvotes").order("desc").collect();
        }

        return ctx.db.query("feedback").order("desc").collect();
    });

export const get = query
    .input({ id: v.id("feedback") })
    .query(async ({ args: { id }, ctx }): Promise<Doc<"feedback"> | null> => (await ctx.db.get(id)) ?? null);

export const comments = query.input({ feedbackId: v.id("feedback") }).query(async ({ args: { feedbackId }, ctx }): Promise<Doc<"comments">[]> => {
    const rows = await ctx.db
        .query("comments")
        .withIndex("by_feedback", (q) => q.eq("feedbackId", feedbackId))
        .collect();

    return [...rows].sort((a, b) => a._creationTime - b._creationTime);
});

/** Which of these posts the given voter has already upvoted — one query for the whole page, rather than one per card. */
export const myVotes = query.input({ voterEmail: v.string().max(254) }).query(async ({ args: { voterEmail }, ctx }): Promise<Id<"feedback">[]> => {
    const rows = await ctx.db
        .query("votes")
        .withIndex("by_voter", (q) => q.eq("voterEmail", voterEmail))
        .collect();

    return rows.map((vote) => vote.feedbackId);
});

export const create = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({
        title: v.string().max(200),
        description: v.string().max(4000),
        authorName: v.string().max(80),
        authorEmail: v.optional(v.string().max(254)),
        tags: v.optional(v.array(v.string().max(40))),
    })
    .mutation(async ({ args: { authorEmail, authorName, description, tags, title }, ctx }): Promise<Id<"feedback">> => {
        const id = await ctx.db.insert("feedback", { authorEmail, authorName, commentCount: 0, description, status: "open", tags, title, upvoteCount: 0 });

        ctx.log.info("feedback created", { id, title });

        return id;
    });

export const setStatus = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("feedback"), status: feedbackStatus })
    .mutation(async ({ args: { id, status }, ctx }): Promise<void> => {
        ctx.log.info("feedback status changed", { id, status });
        await ctx.db.patch(id, { status });
    });

/**
 * Toggle this voter's upvote.
 *
 * The lookup below is a fast path, not the guard: `by_feedback_and_voter` is a
 * unique index, so a double-submit that slips past it fails on the insert rather
 * than double-counting. `upvoteCount` is denormalised onto the post so the board
 * can sort by votes through an index instead of counting rows per card.
 */
export const toggleVote = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ feedbackId: v.id("feedback"), voterEmail: v.string().max(254) })
    .mutation(async ({ args: { feedbackId, voterEmail }, ctx }): Promise<{ voted: boolean }> => {
        const post = await ctx.db.get(feedbackId);

        if (!post) {
            throw new LunoraError("NOT_FOUND", "feedback not found");
        }

        const existing = await ctx.db
            .query("votes")
            .withIndex("by_feedback_and_voter", (q) => q.eq("feedbackId", feedbackId).eq("voterEmail", voterEmail))
            .first();

        if (existing) {
            await ctx.db.delete(existing._id);
            await ctx.db.patch(feedbackId, { upvoteCount: Math.max(0, post.upvoteCount - 1) });
            ctx.log.info("vote withdrawn", { feedbackId });

            return { voted: false };
        }

        await ctx.db.insert("votes", { feedbackId, voterEmail });
        await ctx.db.patch(feedbackId, { upvoteCount: post.upvoteCount + 1 });
        ctx.log.info("vote cast", { feedbackId });

        return { voted: true };
    });

export const addComment = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({
        feedbackId: v.id("feedback"),
        authorName: v.string().max(80),
        authorEmail: v.optional(v.string().max(254)),
        content: v.string().max(4000),
        isOfficial: v.optional(v.boolean()),
    })
    .mutation(async ({ args: { authorEmail, authorName, content, feedbackId, isOfficial }, ctx }): Promise<Id<"comments">> => {
        const post = await ctx.db.get(feedbackId);

        if (!post) {
            throw new LunoraError("NOT_FOUND", "feedback not found");
        }

        const id = await ctx.db.insert("comments", { authorEmail, authorName, content, feedbackId, isOfficial: isOfficial ?? false });

        await ctx.db.patch(feedbackId, { commentCount: post.commentCount + 1 });
        ctx.log.info("comment added", { feedbackId, id });

        return id;
    });

/** Delete a post and everything hanging off it, in one transaction. */
export const remove = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("feedback") })
    .mutation(async ({ args: { id }, ctx }): Promise<void> => {
        // The unique index's leading column is `feedbackId`, so it also serves as
        // the "every vote on this post" lookup.
        const votes = await ctx.db
            .query("votes")
            .withIndex("by_feedback_and_voter", (q) => q.eq("feedbackId", id))
            .collect();

        for (const vote of votes) {
            await ctx.db.delete(vote._id);
        }

        const rows = await ctx.db
            .query("comments")
            .withIndex("by_feedback", (q) => q.eq("feedbackId", id))
            .collect();

        for (const comment of rows) {
            await ctx.db.delete(comment._id);
        }

        ctx.log.info("feedback removed", { comments: rows.length, id, votes: votes.length });
        await ctx.db.delete(id);
    });
