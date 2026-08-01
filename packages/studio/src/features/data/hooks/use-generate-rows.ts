import { useLunora } from "@lunora/react";
import { useState } from "react";

import type { ColumnMeta, ImportShardResult, TableColumnsResult, TablePage } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";
import { MAX_FK_SAMPLE } from "../../../lib/seed-data";

const DESCRIBE_TABLE = adminRef(ADMIN_FUNCTIONS.describeTable);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const IMPORT_SHARD = adminRef(ADMIN_FUNCTIONS.importShard);

/**
 * Extract a string row-id from a raw row object, trying common id column names.
 * Returns an empty string when none match.
 */
const extractId = (row: Record<string, unknown>): string => {
    const raw = row["_id"] ?? row["id"] ?? row["__id__"] ?? "";

    if (typeof raw === "string") {
        return raw;
    }

    if (typeof raw === "number") {
        return String(raw);
    }

    return "";
};

/**
 * Everything the "Generate rows" dialog and its trigger need.
 *
 * The hook fetches column metadata from `describeTable` and FK pools from
 * `readTablePage` lazily (when the dialog opens), then routes generated rows
 * through the bulk `importShard` admin RPC — the same batch path the
 * Export/Import panel uses. All state is local to this hook; the data browser
 * refresh is the caller's responsibility after a successful insert.
 */

/**
 * Outcome of one `insertBatch` call. A bare `string | undefined` (the original
 * `writeRow`-loop contract) can't distinguish "every row inserted" from "every
 * row skipped as an id conflict" — both have no `error` — so the caller needs
 * the real `inserted`/`conflicts` counts to report honestly instead of assuming
 * the requested row count is what actually landed.
 */
interface InsertBatchOutcome {
    /** Rows skipped because their `_id` already existed on the shard (e.g. a re-click with the same seed regenerating the same planned ids). */
    conflicts: number;
    /** Set when the batch had at least one row-level error, naming the first failing row. `undefined` when there were none — a conflict-only result still counts as success. */
    error: string | undefined;
    /** Rows actually inserted (never assume this equals the requested count — conflicts and errors both reduce it). */
    inserted: number;
}

interface UseGenerateRowsModel {
    /** Close the dialog and reset state. */
    closeDialog: () => void;
    /** Column metadata for the selected table, fetched on demand. `undefined` until loaded. */
    columnMeta: ReadonlyArray<ColumnMeta> | undefined;
    /** Error from the most recent load or insert attempt. `undefined` when none. */
    error: string | undefined;
    /** FK pools: ref table name → array of sampled row ids. */
    fkPools: Readonly<Record<string, ReadonlyArray<string>>>;

    /**
     * Insert a batch of pre-generated row documents in ONE `importShard` call.
     * The returned {@link InsertBatchOutcome} carries the REAL inserted/conflict
     * counts — never assume every requested row landed just because `error` is
     * `undefined` (see `composeInsertOutcome`).
     */
    insertBatch: (rows: ReadonlyArray<Record<string, unknown>>, onDone: () => void) => Promise<InsertBatchOutcome>;
    /** True while fetching column meta / FK pools or inserting rows. */
    loading: boolean;
    /** Whether the dialog is currently open. */
    open: boolean;
    /** Open the dialog for the given table / shard (fetches column meta + FK pools). */
    openDialog: (table: string, shardKey: string) => void;
    /** The shard key the dialog is operating against. `undefined` when no dialog is open. */
    shardKey: string | undefined;
    /** The table the dialog is operating against. `undefined` when no dialog is open. */
    table: string | undefined;
}

/**
 * Compose an `importShard` result into an {@link InsertBatchOutcome}. Only a
 * non-empty `errors` array sets `error` — a conflict-only result (every row's
 * `_id` collided with an existing one, e.g. a re-click with the same seed)
 * counts as success, matching the Export/Import panel's semantics, but
 * `inserted`/`conflicts` are always the real counts so the caller can tell
 * "200 inserted" apart from "0 inserted, 200 conflicts" instead of assuming
 * the requested row count is what landed. The error string names the first
 * failing row (by 1-based `line`, which `importShard` treats as the row's
 * position in `rows` since generated rows have no file lines) and table; a
 * trailing count covers the rest so a big batch doesn't dump every failure.
 */
const composeInsertOutcome = (result: ImportShardResult): InsertBatchOutcome => {
    const insertedTotal = Object.values(result.inserted).reduce((sum, count) => sum + count, 0);
    const [firstError] = result.errors;

    if (firstError === undefined) {
        return { conflicts: result.conflicts, error: undefined, inserted: insertedTotal };
    }

    const remaining = result.errors.length - 1;
    const attempted = insertedTotal + result.conflicts + result.errors.length;
    const errorWord = remaining === 1 ? "error" : "errors";
    const suffix = remaining > 0 ? ` (+${remaining.toString()} more ${errorWord})` : "";
    const error = `Inserted ${insertedTotal.toString()} of ${attempted.toString()} rows — row ${firstError.line.toString()} (${firstError.table}): ${firstError.message}${suffix}`;

    return { conflicts: result.conflicts, error, inserted: insertedTotal };
};

/**
 * Manages the full lifecycle of the "Generate & insert dummy rows" dialog:
 * - Fetches column metadata from `describeTable` when the dialog opens.
 * - Fetches FK pools (sampled row ids) from `readTablePage` for each FK column.
 * - Routes generated rows through the bulk `importShard` admin RPC in one call, instead of one `writeRow` round trip per row.
 *
 * Used exclusively by `DataBrowser` — not a shared hook.
 */
const useGenerateRows = (onRefresh: () => void): UseGenerateRowsModel => {
    const client = useLunora();

    const [open, setOpen] = useState<boolean>(false);
    const [table, setTable] = useState<string | undefined>(undefined);
    const [shardKey, setShardKey] = useState<string | undefined>(undefined);
    const [columnMeta, setColumnMeta] = useState<ReadonlyArray<ColumnMeta> | undefined>(undefined);
    const [fkPools, setFkPools] = useState<Readonly<Record<string, ReadonlyArray<string>>>>({});
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | undefined>(undefined);

    const openDialogAsync = async (targetTable: string, targetShard: string): Promise<void> => {
        setOpen(true);
        setTable(targetTable);
        setShardKey(targetShard);
        setColumnMeta(undefined);
        setFkPools({});
        setError(undefined);
        setLoading(true);

        try {
            // Fetch the column metadata for this table.
            const result = (await client.query(DESCRIBE_TABLE, { table: targetTable }, callOptions(targetShard))) as TableColumnsResult;
            const { columns } = result;

            setColumnMeta(columns);

            // For each FK column, sample a pool of existing row ids.
            const pools: Record<string, ReadonlyArray<string>> = {};
            const fkColumns = columns.filter((column) => column.ref !== undefined && column.type === "id" && column.pk !== true);

            for (const fkColumn of fkColumns) {
                if (fkColumn.ref === undefined) {
                    continue;
                }

                const { ref } = fkColumn;

                if (pools[ref] !== undefined) {
                    // Already sampled for this ref table.
                    continue;
                }

                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential: each FK table needs its own read
                    const page = (await client.query(
                        READ_TABLE_PAGE,
                        { filters: [], limit: MAX_FK_SAMPLE, offset: 0, search: "", table: ref },
                        callOptions(targetShard),
                    )) as TablePage;

                    // One pass, and `flatMap` narrows away the empty ids that
                    // `.filter(Boolean)` only removes at runtime.
                    pools[ref] = page.rows.flatMap((row) => extractId(row) || []);
                } catch {
                    // FK pool unavailable — the column will be skipped.
                    pools[ref] = [];
                }
            }

            setFkPools(pools);
        } catch (error_) {
            setError((error_ as Error).message);
        }

        setLoading(false);
    };

    const openDialog = (targetTable: string, targetShard: string): void => {
        fireAndForget(openDialogAsync(targetTable, targetShard));
    };

    const closeDialog = (): void => {
        setOpen(false);
        setTable(undefined);
        setShardKey(undefined);
        setColumnMeta(undefined);
        setFkPools({});
        setError(undefined);
    };

    const insertBatch = async (rows: ReadonlyArray<Record<string, unknown>>, onDone: () => void): Promise<InsertBatchOutcome> => {
        if (table === undefined || shardKey === undefined) {
            return { conflicts: 0, error: "No table selected.", inserted: 0 };
        }

        try {
            const result = (await client.query(
                IMPORT_SHARD,
                {
                    rows: rows.map((document_) => {
                        return { doc: document_, table };
                    }),
                },
                callOptions(shardKey),
            )) as ImportShardResult;

            const outcome = composeInsertOutcome(result);

            if (outcome.error !== undefined) {
                return outcome;
            }

            onDone();
            onRefresh();

            return outcome;
        } catch (error_) {
            return { conflicts: 0, error: (error_ as Error).message, inserted: 0 };
        }
    };

    return { closeDialog, columnMeta, error, fkPools, insertBatch, loading, open, openDialog, shardKey, table };
};

export { useGenerateRows };
export type { InsertBatchOutcome, UseGenerateRowsModel };
