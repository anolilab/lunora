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
 * Each table is read page by page until a read holds nothing new. A deleted row
 * drops out of the next read, so a table larger than one page is cleared in full.
 * The seen-set makes a store that keeps a deleted row (a double, for one) stop
 * after the pass that found it rather than re-deleting it forever.
 */
export const purgeScopedRows = async (context: MutationContext, tables: ReadonlyArray<TableName>, where: Record<string, unknown>): Promise<void> => {
    for (const table of tables) {
        const facade = context.db[table] as unknown as {
            findMany: (query: { where: Record<string, unknown> }) => Promise<{ page: { _id: string }[] }>;
        };
        const seen = new Set<string>();

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- sequential per-table purge keeps the writer simple
            const { page: rows } = await facade.findMany({ where });
            const fresh = rows.filter((row) => !seen.has(row._id));

            if (fresh.length === 0) {
                break;
            }

            for (const row of fresh) {
                seen.add(row._id);
                // eslint-disable-next-line no-await-in-loop -- sequential deletes; a single scope's volumes are small
                await context.db.delete(row._id as never);
            }
        }
    }
};

/** The `referenceId` a financial row carries once its organization is erased. */
export const ERASED_REFERENCE = "erased";

/**
 * Anonymise every row of `table` matching `where`: `redact` returns the fields
 * that identify the subject, and the row keeps the rest (amounts, dates, state).
 * A redacted row no longer matches `where`, so the read drops it, and the
 * seen-set covers a store that keeps matching after a patch.
 */
export const anonymiseScopedRows = async (
    context: MutationContext,
    table: TableName,
    where: Record<string, unknown>,
    redact: (row: Record<string, unknown> & { _id: string }) => Record<string, unknown>,
): Promise<void> => {
    const facade = context.db[table] as unknown as {
        findMany: (query: { where: Record<string, unknown> }) => Promise<{ page: (Record<string, unknown> & { _id: string })[] }>;
    };
    const seen = new Set<string>();

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- sequential per-table pass keeps the writer simple
        const { page: rows } = await facade.findMany({ where });
        const fresh = rows.filter((row) => !seen.has(row._id));

        if (fresh.length === 0) {
            break;
        }

        for (const row of fresh) {
            seen.add(row._id);
            // eslint-disable-next-line no-await-in-loop -- sequential patches; a single scope's volumes are small
            await context.db.patch(row._id as never, redact(row));
        }
    }
};
