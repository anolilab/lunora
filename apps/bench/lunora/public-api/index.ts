/**
 * A pay-per-call public endpoint for agents (x402): the price is declared on
 * the procedure, and the charge gate in `lunora/server.ts` settles it before the
 * handler runs.
 *
 * Paying proves nothing about who the caller is, so the feed is aggregate only:
 * how many organisations are on each plan, never a row of any one tenant.
 *
 * Anonymous callers reach it only through `authorizeShard` in `lunora/server.ts`,
 * which admits them to `public_api:planMix` on the root shard and no other call (FINDINGS.md 20).
 */
import { query } from "../_generated/server";
import { PLANS } from "../plans";

/**
 * Reads the `countByStatusPlan` aggregate (see `lunora/saas/schema.ts`): one row per
 * status and plan, so the work is the status and plan count, not the tenant count.
 */
export const planMix = query.x402({ price: "$0.001" }).query(async ({ ctx }): Promise<{ byPlan: Record<string, number>; organizations: number }> => {
    const groups = await ctx.db.saas_organizations.groupBy({ agg: { op: "count" }, by: ["status", "plan"] });
    const byPlan = Object.fromEntries(
        PLANS.map((plan) => [
            plan.id,
            groups.filter(({ key }) => key.plan === plan.id && key.status !== "deleted").reduce((sum, { value }) => sum + (value ?? 0), 0),
        ]),
    );

    return { byPlan, organizations: Object.values(byPlan).reduce((sum, count) => sum + count, 0) };
});
