/**
 * A pay-per-call public endpoint for agents (x402): the price is declared on
 * the procedure, and the charge gate in `lunora/server.ts` settles it before the
 * handler runs.
 *
 * Paying proves nothing about who the caller is, so the feed is aggregate only:
 * how many organisations are on each plan, never a row of any one tenant.
 *
 * Still needs a session: `authorizeShard` in `lunora/server.ts` refuses anonymous
 * callers on every shard and cannot single this procedure out (FINDINGS.md 20).
 */
import { query } from "../_generated/server";
import { PLANS } from "../plans";

/** One `COUNT` per catalog plan, so the work is the catalog's size, not the tenant count. */
export const planMix = query.x402({ price: "$0.001" }).query(async ({ ctx }): Promise<{ byPlan: Record<string, number>; organizations: number }> => {
    const counts = await Promise.all(
        PLANS.map(async (plan) => [plan.id, await ctx.db.saas_organizations.count({ plan: plan.id, status: { ne: "deleted" } })] as const),
    );

    return { byPlan: Object.fromEntries(counts), organizations: counts.reduce((sum, [, count]) => sum + count, 0) };
});
