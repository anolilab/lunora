/**
 * The task assistant: starts a durable `support` agent run on the caller's
 * thread, and the two read tools the agent calls back into.
 *
 * The tools run under the agent's system dispatch, with no end-user identity
 * and no tenant RLS, so each one filters by the organisation named in its
 * arguments. `agents.ts` takes that id from the run's thread key, which only
 * {@link ask} sets, from the caller's verified identity.
 */
import { internalQuery, v } from "../_generated/server.js";
import { orgMutation, requireWriter } from "../lib/crpc.js";

export const ask = orgMutation.input({ message: v.string().min(1).max(4000) }).mutation(async ({ args, ctx }) => {
    const { organizationId, userId } = await requireWriter(ctx);
    const threadKey = `${organizationId}:${userId}`;
    const { id } = await ctx.agents.support.run({ input: args.message, owner: userId, threadKey, title: "Task assistant" });

    return { runId: id, threadKey };
});

export const searchTasks = internalQuery.input({ organizationId: v.string().min(1), term: v.string().min(1).max(200) }).query(async ({ args, ctx }) =>
    ctx.db
        .query("tasks")
        .withSearchIndex("search_title", (q) => q.search("title", args.term).eq("organizationId", args.organizationId))
        .take(10),
);

const OPEN_STATUSES = ["todo", "doing", "review"] as const;

/** Newest first across the open statuses: the index orders by status before `updatedAt`, so each status is read on its own. */
export const openTasks = internalQuery.input({ organizationId: v.string().min(1) }).query(async ({ args, ctx }) => {
    const perStatus = await Promise.all(
        OPEN_STATUSES.map(async (status) =>
            ctx.db
                .query("tasks")
                .withIndex("byOrgStatus", (q) => q.eq("organizationId", args.organizationId).eq("status", status))
                .order("desc")
                .take(20),
        ),
    );

    return perStatus
        .flat()
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20);
});
