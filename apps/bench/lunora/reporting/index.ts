/**
 * Warehouse reads over Hyperdrive (Postgres). Local dev runs against embedded
 * PGlite, so this needs no database; deploy sets the real connection.
 */
import { v } from "../_generated/server.js";
import { authAction, requireOrg } from "../lib/crpc.js";

export const revenueByMonth = authAction.input({ months: v.optional(v.number().int().min(1).max(36)) }).action(async ({ args, ctx }) => {
    const { organizationId } = await requireOrg(ctx);

    return ctx.sql.query<{ month: string; revenue: number }>(
        "select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month, sum(amount)::float as revenue from invoices where organization_id = $1 group by 1 order by 1 desc limit $2",
        [organizationId, args.months ?? 12],
    );
});
