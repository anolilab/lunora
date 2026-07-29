import { useLunora } from "@lunora/react";
import { useState } from "react";

import type { ColumnMeta, TableColumnsResult, TablePage, WriteRowResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";
import { MAX_FK_SAMPLE } from "../../../lib/seed-data";

const DESCRIBE_TABLE = adminRef(ADMIN_FUNCTIONS.describeTable);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const WRITE_ROW = adminRef(ADMIN_FUNCTIONS.writeRow);

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
 * through the schema-aware `writeRow` insert path — the same path the
 * add-row form uses. All state is local to this hook; the data browser
 * refresh is the caller's responsibility after a successful insert.
 */
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
     * Insert a batch of pre-generated row documents. Routes each through
     * `writeRow insert`. Returns `undefined` on full success or an error string on
     * the first failure.
     */
    insertBatch: (rows: ReadonlyArray<Record<string, unknown>>, onDone: () => void) => Promise<string | undefined>;
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
 * Manages the full lifecycle of the "Generate & insert dummy rows" dialog:
 * - Fetches column metadata from `describeTable` when the dialog opens.
 * - Fetches FK pools (sampled row ids) from `readTablePage` for each FK column.
 * - Routes generated rows through the schema-aware `writeRow` insert path.
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

    const insertBatch = async (rows: ReadonlyArray<Record<string, unknown>>, onDone: () => void): Promise<string | undefined> => {
        if (table === undefined || shardKey === undefined) {
            return "No table selected.";
        }

        try {
            for (const rowDocument of rows) {
                // eslint-disable-next-line no-await-in-loop -- sequential inserts through schema-aware writer; failure pins the offending row
                (await client.query(WRITE_ROW, { doc: rowDocument, op: "insert", table }, callOptions(shardKey))) as WriteRowResult;
            }

            onDone();
            onRefresh();

            return undefined;
        } catch (error_) {
            return (error_ as Error).message;
        }
    };

    return { closeDialog, columnMeta, error, fkPools, insertBatch, loading, open, openDialog, shardKey, table };
};

export { useGenerateRows };
export type { UseGenerateRowsModel };
