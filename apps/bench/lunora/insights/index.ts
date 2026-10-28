/**
 * Dashboard counters: Workers KV as a cross-shard cache of each tenant's
 * headline numbers, and Analytics Engine for product events.
 */
import { internalMutation, v } from "../_generated/server.js";
import { orgQuery, requireOrg } from "../lib/crpc.js";

interface Headline {
    computedAt: number;
    done: number;
    open: number;
}

export const headline = orgQuery.query(async ({ ctx }): Promise<Headline | null> => {
    const { organizationId } = await requireOrg(ctx);

    return ctx.kv.get<Headline>(`headline:${organizationId}`);
});

/** Recomputes the cached headline; scheduled after task writes by the nightly maintenance. */
export const refreshHeadline = internalMutation.input({ organizationId: v.string() }).mutation(async ({ args, ctx }) => {
    const rows = await ctx.db
        .query("tasks")
        .withIndex("byOrgStatus", (q) => q.eq("organizationId", args.organizationId))
        .take(5000);
    const next: Headline = {
        computedAt: Date.now(),
        done: rows.filter((row) => row.status === "done").length,
        open: rows.filter((row) => row.status !== "done" && row.status !== "archived").length,
    };

    await ctx.kv.put(`headline:${args.organizationId}`, next, { expirationTtl: 86_400 });
    ctx.analytics.track("headline.refresh", { dimensions: { organizationId: args.organizationId }, metrics: { open: next.open } });

    return next;
});
