import type { TableName } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";

/**
 * Hard-delete every row of `tables` matching `where`.
 *
 * Indexing `ctx.db` by a variable gives a union of every table's facade, and
 * those call signatures do not unify — so a sweep that visits tables by name has
 * to go through a structural view of the one method it calls. That cast lives
 * here, once, rather than at each caller.
 *
 * The reads are one page per table: both callers purge rows scoped to a single
 * organization or project, which stays well inside the page cap. A table that
 * could exceed it needs {@link collectAll}, not this.
 */
export const purgeScopedRows = async (context: MutationContext, tables: ReadonlyArray<TableName>, where: Record<string, unknown>): Promise<void> => {
    for (const table of tables) {
        const facade = context.db[table] as unknown as {
            findMany: (query: { where: Record<string, unknown> }) => Promise<{ page: { _id: string }[] }>;
        };
        // eslint-disable-next-line no-await-in-loop -- sequential per-table purge keeps the writer simple
        const { page: rows } = await facade.findMany({ where });

        for (const row of rows) {
            // eslint-disable-next-line no-await-in-loop -- sequential deletes; a single scope's volumes are small
            await context.db.delete(row._id as never);
        }
    }
};
