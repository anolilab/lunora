/**
 * What an import would do to the rows a deployment already holds, worked out
 * before it writes: per table, the rows it adds, the stored rows its `_id`s
 * match, and — under `replace` — the stored rows it would delete.
 *
 * A dry-run import cannot say this: the endpoint's check validates shapes and
 * probes nothing. So the plan reads the target's rows for the tables the file
 * names and compares `_id`s here.
 */
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

/** The source file's rows per table, and the `_id`s they carry. */
type SourceIndex = Map<string, { ids: Set<string>; rows: number }>;

/** Record one wire row (`{"table":…,"doc":…}`) the import will send. */
const recordSourceRow = (index: SourceIndex, wireRow: string): void => {
    const { doc, table } = JSON.parse(wireRow) as { doc?: { _id?: unknown }; table?: unknown };

    if (typeof table !== "string") {
        return;
    }

    let entry = index.get(table);

    if (entry === undefined) {
        entry = { ids: new Set(), rows: 0 };
        index.set(table, entry);
    }

    entry.rows += 1;

    if (typeof doc?._id === "string") {
        entry.ids.add(doc._id);
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
const planImport = async (target: ExportTarget, index: SourceIndex, mode: ImportMode): Promise<ImportPlan> => {
    const tables = new Map<string, TablePlan>();

    for (const [table, entry] of index) {
        tables.set(table, { add: entry.rows, delete: 0, existing: 0, source: entry.rows, table, target: 0 });
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
            deletions.push(row);
        }

        return undefined;
    });

    return { deletions, tables: [...tables.values()].toSorted((a, b) => a.table.localeCompare(b.table)) };
};

/** Print the plan as one line per table. */
const reportPlan = (logger: Logger, plan: ImportPlan, mode: ImportMode): void => {
    const existingVerb = mode === "append" || mode === "require-empty" ? "left unchanged" : "replaced";

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
    (mode === "upsert" || mode === "replace") && plan.tables.some((table) => table.existing > 0 || table.delete > 0);

export type { ImportMode, ImportPlan, SourceIndex, TablePlan };
export { IMPORT_MODES, parseImportMode, planDestroysRows, planImport, recordSourceRow, reportPlan };
