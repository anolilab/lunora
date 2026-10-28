/**
 * A pay-per-call public endpoint for agents (x402): the price is declared on
 * the procedure, and the charge gate in `lunora/server.ts` settles it before the
 * handler runs.
 *
 * Paying proves nothing about who the caller is, so the feed is aggregate only:
 * how many organisations are on each plan, never a row of any one tenant.
 */
import { query } from "../_generated/server.js";

export const planMix = query.x402({ price: "$0.001" }).query(async ({ ctx }): Promise<{ byPlan: Record<string, number>; organizations: number }> => {
    const { page } = await ctx.db.saas_organizations.findMany({ where: { status: { ne: "deleted" } } });
    const byPlan: Record<string, number> = {};

    for (const organization of page) {
        byPlan[organization.plan] = (byPlan[organization.plan] ?? 0) + 1;
    }

    return { byPlan, organizations: page.length };
});
