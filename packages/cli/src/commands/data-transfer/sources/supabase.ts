/**
 * Supabase source reader: one CSV per table, as
 * `COPY <t> TO STDOUT WITH CSV HEADER` or the dashboard export produces.
 *
 * CSV is the portable contract — every hosted Postgres can emit it, and it needs
 * no live database connection or extra credential. Parsing is delegated to
 * `csv-parse` rather than hand-rolled: `COPY` quoting, embedded newlines, and
 * doubled quotes are exactly the cases a naive split gets wrong on the one file
 * an operator cannot re-create.
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { LunoraError } from "@lunora/errors";
import { parse } from "csv-parse";

import type { Logger } from "../../../util/logger";
import type { ImportSourceMapping, TableMapping } from "./mapping";
import { applyReshape } from "./reshape";

/** Postgres `COPY … WITH (FORMAT text)` writes NULL as `\N`; CSV mode writes it unquoted-empty. */
const TEXT_FORMAT_NULL = String.raw`\N`;

/** One `<table>.csv` in a Supabase dump directory. */
interface SupabaseTableFile {
    file: string;
    table: string;
}

/**
 * Find the CSV files in a dump directory, resolving each to its Lunora table.
 *
 * A mapping entry may name its file explicitly (`auth.users.csv` → `users`);
 * anything unnamed falls back to `<table>.csv`. Files the mapping does not
 * mention are still imported under their stem, so a dump of twenty tables needs
 * a mapping only for the columns that actually need reshaping.
 */
const listSupabaseTables = async (directory: string, mapping: ImportSourceMapping | undefined): Promise<SupabaseTableFile[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);

    if (entries === undefined) {
        throw new LunoraError("INTERNAL", `${directory} is not a readable directory of Supabase CSV exports`);
    }

    const csvFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv")).map((entry) => entry.name);
    const claimed = new Map<string, string>();

    for (const [table, tableMapping] of Object.entries(mapping?.tables ?? {})) {
        if (tableMapping.file !== undefined) {
            claimed.set(tableMapping.file, table);
        }
    }

    const found: SupabaseTableFile[] = [];

    for (const name of csvFiles) {
        // A mapping `file` is operator-supplied and joined onto a path, so it is
        // matched by basename rather than trusted as a path fragment.
        const table = claimed.get(name) ?? basename(name, ".csv");

        found.push({ file: join(directory, name), table });
    }

    if (found.length === 0) {
        throw new LunoraError("INTERNAL", `${directory} holds no .csv files — export each table with \`COPY <table> TO STDOUT WITH CSV HEADER\` first`);
    }

    return found.toSorted((a, b) => a.table.localeCompare(b.table));
};

/**
 * Turn one CSV row into a Lunora document.
 *
 * The id column is preserved as `_id` verbatim — that is what lets foreign keys
 * survive without a second remapping pass, exactly as the Convex importer relies
 * on.
 */
const toDocument = (row: Record<string, string | null>, tableMapping: TableMapping | undefined): Record<string, unknown> => {
    const idColumn = tableMapping?.idColumn ?? "id";
    const types = tableMapping?.types ?? {};
    const document: Record<string, unknown> = {};

    for (const [column, raw] of Object.entries(row)) {
        const kind = types[column];
        const value = kind === undefined ? raw : applyReshape(column, kind, raw);

        if (column === idColumn) {
            if (raw === null) {
                throw new LunoraError("INTERNAL", `id column \`${idColumn}\` is NULL — every row needs an id to preserve`);
            }

            document["_id"] = raw;
        } else {
            document[column] = value;
        }
    }

    return document;
};

/**
 * Stream one table's CSV as `{ table, doc }` NDJSON, tallying rows as it goes.
 *
 * `cast` distinguishes NULL from the empty string the way Postgres CSV does:
 * an *unquoted* empty field is NULL, a quoted `""` is a genuine empty string.
 * Collapsing the two would turn every empty text column into a null.
 */
const readSupabaseTable = async function* (
    tableFile: SupabaseTableFile,
    mapping: ImportSourceMapping | undefined,
    sourceRows: Map<string, number>,
): AsyncGenerator<string> {
    const tableMapping = mapping?.tables?.[tableFile.table];

    const parser = createReadStream(tableFile.file).pipe(
        parse({
            cast: (value, context) => {
                if (context.header) {
                    return value;
                }

                // eslint-disable-next-line unicorn/no-null -- a SQL NULL is `null`; `undefined` would drop the column from the row
                return (!context.quoting && value.length === 0) || value === TEXT_FORMAT_NULL ? null : value;
            },
            columns: true,
            relaxColumnCountLess: false,
            skipEmptyLines: true,
        }),
    );

    let lineNumber = 0;

    try {
        for await (const row of parser) {
            lineNumber += 1;

            const document = toDocument(row as Record<string, string | null>, tableMapping);

            sourceRows.set(tableFile.table, (sourceRows.get(tableFile.table) ?? 0) + 1);

            yield `${JSON.stringify({ doc: document, table: tableFile.table })}\n`;
        }
    } catch (error: unknown) {
        throw new LunoraError(
            "INTERNAL",
            `${basename(tableFile.file)} row ${String(lineNumber + 1)}: ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            },
        );
    }
};

/**
 * Stream a whole Supabase CSV dump directory as the `{ table, doc }` NDJSON the
 * admin import endpoint accepts.
 */
const readSupabaseExport = async function* (
    tables: ReadonlyArray<SupabaseTableFile>,
    mapping: ImportSourceMapping | undefined,
    logger: Logger,
    sourceRows: Map<string, number>,
): AsyncGenerator<string> {
    for (const tableFile of tables) {
        // Seed the tally so an empty table still appears in the parity report —
        // absent-vs-zero is "never read" vs "nothing to import".
        if (!sourceRows.has(tableFile.table)) {
            sourceRows.set(tableFile.table, 0);
        }

        logger.info(`reading ${basename(tableFile.file)} → ${tableFile.table}`);

        yield* readSupabaseTable(tableFile, mapping, sourceRows);
    }
};

export type { SupabaseTableFile };
export { listSupabaseTables, readSupabaseExport, toDocument };
