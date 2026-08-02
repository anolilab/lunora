import { generateText } from "@lunora/ai";
import { LunoraError } from "@lunora/errors";

import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { action, internalMutation, mutation, query, v } from "./_generated/server.js";

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
export const generate = action.input({ limit: v.optional(v.number()) }).action(async ({ args: { limit }, ctx }): Promise<Id<"summaries"> | null> => {
    const top = (await ctx.runQuery(api.feedback.list, { sortBy: "votes" })).slice(0, Math.min(Math.max(limit ?? 10, 1), 50));

    if (top.length === 0) {
        return null;
    }

    const board = top.map((post, index) => `${index + 1}. ${post.title} (${post.upvoteCount} votes)\n   ${post.description}`).join("\n\n");

    let text: string;

    try {
        ({ text } = await generateText({
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

export const remove = mutation.input({ id: v.id("summaries") }).mutation(async ({ args: { id }, ctx }): Promise<void> => {
    await ctx.db.delete(id);
});
