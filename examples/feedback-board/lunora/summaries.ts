import { generateText } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { action, internalMutation, mutation, query, v } from "./_generated/server.js";

/**
 * Inference costs money per call, so it gets a far tighter bucket than the
 * board's writes.
 *
 * One limiter per context kind. A middleware's context type flows into the
 * handler, so a single limiter typed loosely enough to serve both would erase
 * `ctx.ai` on the action and `ctx.db` on the mutation.
 */
const actionLimiter = (ctx: ActionCtx) => makeRateLimiter(ctx);
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: { ip?: string }): string => ctx.ip ?? "anon" };

/** Newest first. The board renders whichever summary is on top. */
export const list = query.query(async ({ ctx }): Promise<Doc<"summaries">[]> => ctx.db.query("summaries").withIndex("by_generated").order("desc").collect());

/**
 * Read the top-voted posts and write a summary of what people are asking for.
 *
 * This is an `action`, not a mutation: inference is a network call, so it is
 * outside the shard's transaction. `ctx.ai` is wired onto the action context by
 * codegen the moment this file imports `@lunora/ai`, and the Workers AI binding
 * is the zero-config default — pass any other AI SDK model to `generateText` to
 * switch providers.
 *
 * Reads go through `ctx.runQuery` and the write lands via an internal mutation,
 * so the durable part of the work is still one transaction on the shard.
 */
export const generate = action
    .use(rateLimit(actionLimiter, "ai", byCaller))
    .input({ limit: v.optional(v.number()) })
    .action(async ({ args: { limit }, ctx }): Promise<Id<"summaries"> | null> => {
        const top = (await ctx.runQuery(api.feedback.list, { sortBy: "votes" })).slice(0, Math.min(Math.max(limit ?? 10, 1), 50));

        if (top.length === 0) {
            return null;
        }

        const board = top.map((post, index) => `${index + 1}. ${post.title} (${post.upvoteCount} votes)\n   ${post.description}`).join("\n\n");

        let text: string;

        ctx.log.info("summarising board", { posts: top.length });

        try {
            ({ text } = await generateText({
                // Bounded on purpose: an unbounded public generation is an open
                // invitation to burn tokens, and a board summary has no business
                // being long.
                maxOutputTokens: 700,
                model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
                prompt: [
                    "You are summarising a public product feedback board for the team that owns the product.",
                    "Group the requests into themes, name the strongest signal, and call out anything that reads like a bug rather than a feature request.",
                    "Answer in short markdown sections. Do not invent requests that are not listed.",
                    "",
                    "Feedback:",
                    board,
                ].join("\n"),
            }));
        } catch (error) {
            // Inference is the one part of this app that leaves the shard, so it is
            // the one part that fails for reasons the board cannot fix. Say which
            // dependency broke rather than surfacing a raw provider error.
            throw new LunoraError("INTERNAL", "summary generation failed: Workers AI did not answer", { cause: error });
        }

        ctx.log.info("summary generated", { characters: text.length });

        return ctx.runMutation(internal.summaries.store, {
            feedbackIds: top.map((post) => post._id),
            summary: text,
            title: `Top ${top.length} requests`,
        });
    });

/** Internal: only `generate` may write a summary, so this is not part of the public API. */
export const store = internalMutation
    .input({ title: v.string(), summary: v.string(), feedbackIds: v.array(v.id("feedback")) })
    .mutation(async ({ args: { feedbackIds, summary, title }, ctx }): Promise<Id<"summaries">> =>
        ctx.db.insert("summaries", { feedbackIds, generatedAt: Date.now(), summary, title }),
    );

export const remove = mutation
    .use(rateLimit(mutationLimiter, "write", byCaller))
    .input({ id: v.id("summaries") })
    .mutation(async ({ args: { id }, ctx }): Promise<void> => {
        ctx.log.info("summary removed", { id });
        await ctx.db.delete(id);
    });
