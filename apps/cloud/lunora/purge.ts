import type { TableName } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";

type MatchingRow = Record<string, unknown> & { _id: string };

/**
 * `ctx.db` indexed by a variable is a union of every table's facade, and those call
 * signatures do not unify. The sweep needs one method of one table, so the structural
 * view of `findMany` lives here, once, rather than at each caller.
 */
interface TableFacade {
    findMany: (query: { where: Record<string, unknown> }) => Promise<{ page: MatchingRow[] }>;
}

/**
 * Visit every row of `table` matching `where` with `act`, page by page, until a read
 * holds nothing new. A row `act` removes or redacts drops out of the next read, so a
 * table larger than one page is covered in full. The seen-set makes a store that keeps
 * a row matching (a double, for one) stop after the pass that found it rather than
 * visiting it forever.
 */
const sweepScopedRows = async (
    context: MutationContext,
    table: TableName,
    where: Record<string, unknown>,
    act: (row: MatchingRow) => Promise<unknown>,
): Promise<void> => {
    const facade = context.db[table] as unknown as TableFacade;
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
            // eslint-disable-next-line no-await-in-loop -- sequential writes; a single scope's volumes are small
            await act(row);
        }
    }
};

/** Hard-delete every row of each of `tables` matching `where`. */
export const purgeScopedRows = async (context: MutationContext, tables: ReadonlyArray<TableName>, where: Record<string, unknown>): Promise<void> => {
    for (const table of tables) {
        // eslint-disable-next-line no-await-in-loop -- one table at a time keeps the writer simple
        await sweepScopedRows(context, table, where, (row) => context.db.delete(row._id as never));
    }
};

/** The `referenceId` a financial row carries once its organization is erased. */
export const ERASED_REFERENCE = "erased";

/**
 * Anonymise every row of `table` matching `where`: `redact` returns the fields that
 * identify the subject, and the row keeps the rest (amounts, dates, state). A redacted
 * row no longer matches `where`, so the next read drops it.
 */
export const anonymiseScopedRows = (
    context: MutationContext,
    table: TableName,
    where: Record<string, unknown>,
    redact: (row: MatchingRow) => Record<string, unknown>,
): Promise<void> => sweepScopedRows(context, table, where, (row) => context.db.patch(row._id as never, redact(row)));
