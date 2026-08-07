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
import { basename } from "node:path";

import { LunoraError } from "@lunora/errors";
import { parse } from "csv-parse";

import type { Logger } from "../../../util/logger";
import { readAuthDump } from "./auth";
import type { DumpFile } from "./dump-directory";
import { listDumpFiles, readDumpFiles } from "./dump-directory";
import type { ImportSourceMapping, TableMapping } from "./mapping";
import { applyReshape } from "./reshape";

/**
 * Supabase keeps its auth schema in `auth.*` tables. A dump of one is never
 * application data, and it carries live credential material — the bcrypt hash
 * plus single-use `recovery_token`, `confirmation_token`, `email_change_token_*`
 * and `reauthentication_token` values.
 *
 * Excluding these by *shape* rather than by what a mapping happens to name is
 * the point: the mapping is optional, so keying the exclusion off it meant a
 * dump imported without one sent every hash and reset token over the wire as an
 * ordinary table row.
 */
const AUTH_SCHEMA_PREFIX = "auth.";

/**
 * Columns that are credential material in any table. A row carrying one is
 * refused rather than filtered, because its presence means the file is an auth
 * dump the exclusions did not catch — and quietly dropping the column would hide
 * that.
 */
const CREDENTIAL_COLUMNS = new Set([
    "confirmation_token",
    "email_change_token_current",
    "email_change_token_new",
    "encrypted_password",
    "password",
    "password_hash",
    "passwordhash",
    "reauthentication_token",
    "recovery_token",
    "salt",
]);

/** Postgres `COPY … WITH (FORMAT text)` writes NULL as `\N`; CSV mode writes it unquoted-empty. */
const TEXT_FORMAT_NULL = String.raw`\N`;

/**
 * Parse Postgres CSV, distinguishing NULL from the empty string the way `COPY`
 * encodes them: an *unquoted* empty field is NULL, a quoted `""` is a genuine
 * empty string, and `\N` is NULL in the text format. Shared with the auth
 * reader — a second copy of this callback had already drifted, losing the `\N`
 * case and turning null emails into the literal string "\N".
 */
const castPostgresCsv = (value: string, context: { header: boolean; quoting: boolean }): null | string => {
    if (context.header) {
        return value;
    }

    // eslint-disable-next-line unicorn/no-null -- a SQL NULL is `null`; `undefined` would drop the column from the row
    return (!context.quoting && value.length === 0) || value === TEXT_FORMAT_NULL ? null : value;
};

/** Auth dumps the mapping claims, plus anything in Postgres's `auth.` schema. */
const authFilesFor = (mapping: ImportSourceMapping | undefined): Set<string> =>
    new Set([mapping?.auth?.file, mapping?.auth?.identitiesFile].filter((file): file is string => file !== undefined).map((file) => basename(file)));

/** Find the CSV files in a dump directory, resolving each to its Lunora table. */
const listSupabaseTables = async (directory: string, mapping: ImportSourceMapping | undefined): Promise<DumpFile[]> =>
    listDumpFiles(
        directory,
        mapping,
        {
            authFiles: authFilesFor(mapping),
            emptyMessage: "holds no .csv files — export each table with `COPY <table> TO STDOUT WITH CSV HEADER` first",
            // The `auth.` schema is excluded by SHAPE, not just by what the
            // mapping names: the mapping is optional, and keying the exclusion off
            // it meant a dump imported without one sent every credential column
            // over the wire as an ordinary row.
            matches: (name) => name.toLowerCase().endsWith(".csv") && !name.toLowerCase().startsWith(AUTH_SCHEMA_PREFIX),
            tableNameOf: (name) => basename(name, ".csv"),
        },
        async (path) => readdir(path, { withFileTypes: true }),
    );

/**
 * Turn one CSV row into a Lunora document.
 *
 * The id column is preserved as `_id` verbatim — that is what lets foreign keys
 * survive without a second remapping pass, exactly as the Convex importer relies
 * on.
 */
const toDocument = (row: Record<string, string | null>, tableMapping: TableMapping | undefined, table: string): Record<string, unknown> => {
    const idColumn = tableMapping?.idColumn ?? "id";
    const types = tableMapping?.types ?? {};
    const document: Record<string, unknown> = {};

    for (const [column, raw] of Object.entries(row)) {
        if (CREDENTIAL_COLUMNS.has(column.toLowerCase())) {
            throw new LunoraError(
                "INTERNAL",
                `${table}.${column} is credential material — this looks like an auth dump being imported as a table. Name it under \`auth\` in the mapping instead; passwords are never migrated.`,
            );
        }

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

    // Without this the row imports with no `_id`, the target mints a fresh one,
    // and every foreign key pointing at the old primary key dangles — silently,
    // with `--verify` green, because the row counts still match. Preserving ids
    // is the premise the whole importer rests on, so failing to find one is a
    // hard error rather than a default.
    if (document["_id"] === undefined) {
        throw new LunoraError(
            "INTERNAL",
            `${table}: no \`${idColumn}\` column to preserve as the id (columns present: ${Object.keys(row).join(", ")}). Set \`tables.${table}.idColumn\` in the mapping.`,
        );
    }

    return document;
};

/**
 * Decode one table's CSV into documents.
 *
 * `cast` distinguishes NULL from the empty string the way Postgres CSV does: an
 * unquoted* empty field is NULL, a quoted `""` is a genuine empty string.
 * Collapsing the two would turn every empty text column into a null.
 */
const readSupabaseTable = async function* (dumpFile: DumpFile, mapping: ImportSourceMapping | undefined): AsyncGenerator<Record<string, unknown>> {
    const tableMapping = mapping?.tables?.[dumpFile.table];
    const parser = createReadStream(dumpFile.file).pipe(parse({ cast: castPostgresCsv, columns: true, relaxColumnCountLess: false, skipEmptyLines: true }));
    let lineNumber = 0;

    try {
        for await (const row of parser) {
            lineNumber += 1;

            yield toDocument(row as Record<string, string | null>, tableMapping, dumpFile.table);
        }
    } catch (error: unknown) {
        throw new LunoraError(
            "INTERNAL",
            `${basename(dumpFile.file)} row ${String(lineNumber + 1)}: ${error instanceof Error ? error.message : String(error)}`,
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
    tables: ReadonlyArray<DumpFile>,
    mapping: ImportSourceMapping | undefined,
    logger: Logger,
    sourceRows: Map<string, number>,
    directory: string,
): AsyncGenerator<string> {
    yield* readAuthDump("supabase", directory, mapping, logger, sourceRows);
    yield* readDumpFiles(tables, logger, sourceRows, (dumpFile) => readSupabaseTable(dumpFile, mapping));
};

export { castPostgresCsv, listSupabaseTables, readSupabaseExport, toDocument };
