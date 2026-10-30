/**
 * What an import would do to the rows a deployment already holds, worked out
 * before it writes: per table, the rows it adds, the stored rows its `_id`s
 * match, and — under `replace` — the stored rows it would delete.
 *
 * A dry-run import cannot say this: the endpoint's check validates shapes and
 * probes nothing. So the plan reads the target's rows for the tables the file
 * names and compares `_id`s here.
 */
import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../util/logger";
import type { ExportedRow, ExportTarget } from "./export-rows";
import { forEachExportedRow } from "./export-rows";

/**
 * How an import treats the rows a target already holds:
 *
 * - `append` — insert; a row whose `_id` exists is a conflict left unchanged.
 * - `upsert` — insert; a row whose `_id` exists is overwritten.
 * - `replace` — `upsert`, then delete every stored row of the file's tables whose
 * `_id` the file lacks, so each table ends up holding exactly the file's rows.
 * Tables the file does not name are never touched.
 * - `require-empty` — refuse unless the file's tables hold no rows at all.
 */
type ImportMode = "append" | "replace" | "require-empty" | "upsert";

const IMPORT_MODES: ReadonlyArray<ImportMode> = ["append", "replace", "require-empty", "upsert"];

/** `--mode`'s value as an {@link ImportMode}, `fallback` when absent, or `undefined` when it names no mode. */
const parseImportMode = (raw: string | undefined, fallback: ImportMode): ImportMode | undefined => {
    if (raw === undefined) {
        return fallback;
    }

    return IMPORT_MODES.find((mode) => mode === raw);
};

/** Whether a mode overwrites a stored row whose `_id` the file carries. */
const overwrites = (mode: ImportMode): boolean => mode === "upsert" || mode === "replace";

/** The source file's rows per table, and the `_id`s they carry. */
type SourceIndex = Map<string, { duplicates: number; ids: Set<string>; rows: number; unkeyed: number }>;

/** `value` as a plain object, or `undefined` for anything else (including an array). */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Record one wire row (`{"table":…,"doc":…}`) the import will send. */
const recordSourceRow = (index: SourceIndex, wireRow: string): void => {
    // The line was built by the row transformer, but a malformed one must not take the plan down with a bare SyntaxError.
    let parsed: unknown;

    try {
        parsed = JSON.parse(wireRow);
    } catch {
        return;
    }

    const envelope = asRecord(parsed);
    const table = envelope?.["table"];
    const id = asRecord(envelope?.["doc"])?.["_id"];

    if (typeof table !== "string") {
        return;
    }

    let entry = index.get(table);

    if (entry === undefined) {
        entry = { duplicates: 0, ids: new Set(), rows: 0, unkeyed: 0 };
        index.set(table, entry);
    }

    entry.rows += 1;

    if (typeof id === "string") {
        // A later copy of an `_id` the file already carried overwrites the first (or is a conflict under `append`); it adds nothing.
        if (entry.ids.has(id)) {
            entry.duplicates += 1;
        }

        entry.ids.add(id);
    } else {
        entry.unkeyed += 1;
    }
};

interface TablePlan {
    /** File rows whose `_id` the target does not hold (or that carry none). */
    add: number;
    /** Stored rows the file lacks, which `replace` deletes. Zero for every other mode. */
    delete: number;
    /** File rows whose `_id` the target already holds: conflicts under `append`, overwritten under `upsert`/`replace`. */
    existing: number;
    source: number;
    table: string;
    /** Rows the target holds in this table now. */
    target: number;
}

interface ImportPlan {
    /** The stored rows `replace` deletes, as exported, so each delete routes to the shard that holds it. */
    deletions: ExportedRow[];
    tables: TablePlan[];
}

/** Read the target's rows for the file's tables and compare them with the file. */
const planImport = async (target: ExportTarget, index: SourceIndex, mode: ImportMode, keepDeletions = true): Promise<ImportPlan> => {
    const tables = new Map<string, TablePlan>();

    // A row with no `_id` is written under a fresh one, so a replace could never match it to what a previous run stored: the
    // prune would delete the earlier copy and the write would recreate it under a different id, on every run.
    if (mode === "replace") {
        const unkeyed = [...index].find(([, entry]) => entry.unkeyed > 0);

        if (unkeyed !== undefined) {
            throw new LunoraError(
                "INTERNAL",
                `--mode replace needs every row to carry an _id: ${String(unkeyed[1].unkeyed)} row(s) of ${unkeyed[0]} have none`,
            );
        }
    }

    for (const [table, entry] of index) {
        tables.set(table, { add: entry.rows - entry.duplicates, delete: 0, existing: entry.duplicates, source: entry.rows, table, target: 0 });
    }

    const deletions: ExportedRow[] = [];

    await forEachExportedRow(target, [...index.keys()], (row) => {
        const plan = tables.get(row.table);

        // The export answers only for the tables asked for; anything else is not this plan's to count.
        if (plan === undefined) {
            return undefined;
        }

        plan.target += 1;

        const id = row.doc["_id"];

        if (typeof id === "string" && index.get(row.table)?.ids.has(id) === true) {
            plan.existing += 1;
            plan.add -= 1;
        } else if (mode === "replace") {
            plan.delete += 1;

            if (keepDeletions) {
                deletions.push(row);
            }
        }

        return undefined;
    });

    return { deletions, tables: [...tables.values()].toSorted((a, b) => a.table.localeCompare(b.table)) };
};

/** Print the plan as one line per table. */
const reportPlan = (logger: Logger, plan: ImportPlan, mode: ImportMode): void => {
    const existingVerb = overwrites(mode) ? "replaced" : "left unchanged";

    logger.info(`import plan (--mode ${mode}):`);

    for (const table of plan.tables) {
        const parts = [`${String(table.add)} to add`, `${String(table.existing)} ${existingVerb}`];

        if (mode === "replace") {
            parts.push(`${String(table.delete)} to delete`);
        }

        logger.info(`  ${table.table}: ${String(table.source)} in file, ${String(table.target)} stored — ${parts.join(", ")}`);
    }
};

/** Whether the plan overwrites or deletes a stored row, which is what a confirmation guards. */
const planDestroysRows = (plan: ImportPlan, mode: ImportMode): boolean =>
    overwrites(mode) && plan.tables.some((table) => (table.existing > 0 && table.target > 0) || table.delete > 0);

export type { ImportMode, ImportPlan, SourceIndex, TablePlan };
export { IMPORT_MODES, overwrites, parseImportMode, planDestroysRows, planImport, recordSourceRow, reportPlan };
