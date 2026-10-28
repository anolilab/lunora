/**
 * A pay-per-call public endpoint for agents (x402): the price is declared on
 * the procedure, and the charge gate in `lunora/server.ts` settles it before the
 * handler runs.
 */
import { query, v } from "../_generated/server.js";

export const benchmarkFeed = query
    .x402({ price: "$0.001" })
    .input({ limit: v.optional(v.number().int().min(1).max(100)) })
    .query(async ({ args, ctx }) => {
        const { page } = await ctx.db.saas_organizations.findMany({ where: { status: { ne: "deleted" } } });

        return page.slice(0, args.limit ?? 20).map((organization) => {
            return { plan: organization.plan, seats: organization.seats };
        });
    });
