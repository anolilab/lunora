/**
 * Dashboard counters: Workers KV as a cross-shard cache of each tenant's
 * headline numbers, and Analytics Engine for product events.
 */
import { internalMutation, v } from "../_generated/server.js";
import { orgQuery, requireOrg } from "../lib/crpc";

interface Headline {
    computedAt: number;
    done: number;
    open: number;
}

export const headline = orgQuery.query(async ({ ctx }): Promise<Headline | null> => {
    const { organizationId } = await requireOrg(ctx);

    return ctx.kv.get<Headline>(`headline:${organizationId}`);
});

/** Recomputes the cached headline; the hourly `headline-refresh` cron and the nightly sweep queue it per tenant. */
export const refreshHeadline = internalMutation.input({ organizationId: v.string() }).mutation(async ({ args, ctx }) => {
    const { organizationId } = args;
    // Served by the `countByOrgStatus` aggregate index, so a busy tenant costs the same as an idle one.
    const [all, done, archived] = await Promise.all([
        ctx.db.tasks.count({ organizationId }),
        ctx.db.tasks.count({ organizationId, status: "done" }),
        ctx.db.tasks.count({ organizationId, status: "archived" }),
    ]);
    const next: Headline = { computedAt: Date.now(), done, open: all - done - archived };

    await ctx.kv.put(`headline:${args.organizationId}`, next, { expirationTtl: 86_400 });
    ctx.analytics.track("headline.refresh", { dimensions: { organizationId: args.organizationId }, metrics: { open: next.open } });

    return next;
});
