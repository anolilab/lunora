/**
 * The task assistant: starts a durable `support` agent run on the caller's
 * thread, and the two read tools the agent calls back into.
 */
import { internalQuery, v } from "../_generated/server.js";
import { orgMutation, requireWriter } from "../lib/crpc.js";

export const ask = orgMutation.input({ message: v.string().min(1).max(4000) }).mutation(async ({ args, ctx }) => {
    const { organizationId, userId } = await requireWriter(ctx);
    const threadKey = `${organizationId}:${userId}`;
    const { id } = await ctx.agents.support.run({ input: args.message, owner: userId, threadKey, title: "Task assistant" });

    return { runId: id, threadKey };
});

export const searchTasks = internalQuery.input({ term: v.string().min(1).max(200) }).query(async ({ args, ctx }) =>
    ctx.db
        .query("tasks")
        .withSearchIndex("search_title", (q) => q.search("title", args.term))
        .take(10),
);

export const openTasks = internalQuery.query(async ({ ctx }) =>
    ctx.db
        .query("tasks")
        .withIndex("byOrgStatus", (q) => q)
        .order("desc")
        .take(20),
);
