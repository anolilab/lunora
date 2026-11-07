/**
 * Warehouse reads over Hyperdrive (Postgres). Local dev runs against embedded
 * PGlite, so this needs no database; deploy sets the real connection.
 */
import { LunoraError } from "@lunora/errors";

import { v } from "../_generated/server";
import { authAction, requireOrg } from "../lib/crpc";

/** SQLSTATE `42P01`, undefined_table: the relation is not in the database. */
const UNDEFINED_TABLE = "42P01";

export const revenueByMonth = authAction.input({ months: v.optional(v.number().int().min(1).max(36)) }).action(async ({ args, ctx }) => {
    const { organizationId } = await requireOrg(ctx);

    try {
        return await ctx.sql.query<{ month: string; revenue: number }>(
            "select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month, sum(amount)::float as revenue from invoices where organization_id = $1 group by 1 order by 1 desc limit $2",
            [organizationId, args.months ?? 12],
        );
    } catch (error) {
        // The bench owns no warehouse schema, so `invoices` exists only where the operator created it.
        if ((error as { code?: unknown } | null)?.code === UNDEFINED_TABLE) {
            throw new LunoraError(
                "UNPROCESSABLE",
                'the Hyperdrive database has no "invoices" relation — create it in the warehouse before reading revenue reports',
                {
                    cause: error,
                },
            );
        }

        throw error;
    }
});
