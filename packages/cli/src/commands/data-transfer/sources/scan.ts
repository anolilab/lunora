/**
 * `--scan`: propose a `lunora/import-<source>.json` from the dump itself.
 *
 * The output is a *candidate*, never an authority. Column types are inferred by
 * looking at values, and a column of 100 rows that all happen to parse as dates
 * may still be free text — so the file is written for the operator to review,
 * and a mapping they have already confirmed is never overwritten.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parse } from "csv-parse/sync";

import type { Logger } from "../../../util/logger";
import type { FirestoreCollectionFile } from "./firebase";
import { mappingFileFor } from "./mapping";
import type { ReshapeKind } from "./reshape";
import type { SupabaseTableFile } from "./supabase";

/** How many rows to look at per column before deciding. */
const SCAN_ROW_LIMIT = 200;

const BYTEA_RE = /^\\x[\dA-Fa-f]*$/;
const INTEGER_RE = /^[+-]?\d+$/;
const NUMERIC_RE = /^[+-]?\d+\.\d+$/;
const PG_ARRAY_RE = /^\{.*\}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

/**
 * Ordered most-specific first: a `\x…` blob also looks like text, and an integer
 * also looks like a number, so the first rule whose predicate holds for EVERY
 * value wins.
 */
const INFERENCE_RULES: ReadonlyArray<[((values: ReadonlyArray<string>) => ReshapeKind | undefined) | ReshapeKind, (value: string) => boolean]> = [
    ["bytea-base64", (value) => BYTEA_RE.test(value)],
    ["timestamp-ms", (value) => TIMESTAMP_RE.test(value)],
    // Only propose `int8-string` when a value genuinely needs it — otherwise
    // every id column in the dump would be turned into a string.
    [(values) => (values.some((value) => !Number.isSafeInteger(Number(value))) ? "int8-string" : undefined), (value) => INTEGER_RE.test(value)],
    ["boolean", (value) => value === "f" || value === "t"],
    ["number", (value) => NUMERIC_RE.test(value)],
    [(values) => (values.every((value) => PG_ARRAY_RE.test(value)) ? "text-array" : "json"), (value) => value.startsWith("{") || value.startsWith("[")],
];

/**
 * Infer one column's reshape from its values, or `undefined` to leave it alone.
 *
 * Every branch requires *all* non-null values to agree. One stray value is
 * enough to fall back to "copy it through untouched", which is the safe answer:
 * an un-reshaped column keeps its text, while a wrong reshape either errors on
 * import or silently changes the data.
 */
const inferReshape = (values: ReadonlyArray<string>): ReshapeKind | undefined => {
    if (values.length === 0) {
        return undefined;
    }

    for (const [kind, matches] of INFERENCE_RULES) {
        if (values.every((value) => matches(value))) {
            return typeof kind === "function" ? kind(values) : kind;
        }
    }

    return undefined;
};

/** Column → inferred reshape for one CSV file. */
const scanCsvTable = async (file: string): Promise<Record<string, ReshapeKind>> => {
    const rows: Record<string, string>[] = parse(await readFile(file, "utf8"), { columns: true, skipEmptyLines: true, toLine: SCAN_ROW_LIMIT + 1 });
    const byColumn = new Map<string, string[]>();

    for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
            if (value.length > 0) {
                byColumn.set(column, [...(byColumn.get(column) ?? []), value]);
            }
        }
    }

    const types: Record<string, ReshapeKind> = {};

    for (const [column, values] of byColumn) {
        const kind = inferReshape(values);

        if (kind !== undefined) {
            types[column] = kind;
        }
    }

    return types;
};

/**
 * Write the candidate mapping, refusing to clobber a confirmed one.
 *
 * `wx` is the point: a re-scan of a dump whose mapping the operator has already
 * reviewed must not replace their edits with fresh guesses.
 */
const writeCandidateMapping = async (mapping: unknown, cwd: string, source: "firebase" | "supabase", logger: Logger): Promise<void> => {
    const relative = mappingFileFor(source);
    const mappingPath = join(cwd, relative);
    const serialized = `${JSON.stringify(mapping, undefined, 4)}\n`;

    await mkdir(dirname(mappingPath), { recursive: true });

    try {
        await writeFile(mappingPath, serialized, { encoding: "utf8", flag: "wx" });
        logger.success(`wrote candidate mapping to ${mappingPath} — review the inferred types, then re-run without --scan`);
    } catch (error: unknown) {
        if ((error as { code?: string }).code !== "EEXIST") {
            throw error;
        }

        logger.warn(`${mappingPath} already exists — leaving it untouched. Candidate mapping:`);
        logger.info(serialized);
    }
};

/** Propose a mapping for a Supabase CSV dump by sampling each column. */
const scanSupabaseDump = async (tables: ReadonlyArray<SupabaseTableFile>, cwd: string, logger: Logger): Promise<Record<string, unknown>> => {
    const mapped: Record<string, unknown> = {};

    for (const table of tables) {
        // eslint-disable-next-line no-await-in-loop -- one file at a time keeps the sample bounded
        const types = await scanCsvTable(table.file);

        logger.info(`${basename(table.file)} → ${table.table}: ${String(Object.keys(types).length)} column(s) need a reshape`);
        mapped[table.table] = { file: basename(table.file), idColumn: "id", ...(Object.keys(types).length > 0 ? { types } : {}) };
    }

    const mapping = { keyPrefix: "", tables: mapped };

    await writeCandidateMapping(mapping, cwd, "supabase", logger);

    return mapping;
};

/**
 * Propose a mapping for a Firestore dump.
 *
 * There are no types to infer: the source encoding is already typed, so the
 * decoder knows what each value is. What the operator still has to supply is
 * which columns hold storage paths, so the skeleton lists the collections with
 * an empty `storageColumns` to fill in.
 */
const scanFirebaseDump = async (collections: ReadonlyArray<FirestoreCollectionFile>, cwd: string, logger: Logger): Promise<Record<string, unknown>> => {
    const mapped: Record<string, unknown> = {};

    for (const collection of collections) {
        mapped[collection.table] = { file: basename(collection.file), storageColumns: [] };
    }

    logger.info(`found ${String(collections.length)} collection(s) — Firestore values are self-describing, so only storage columns need declaring`);

    const mapping = { keyPrefix: "", tables: mapped };

    await writeCandidateMapping(mapping, cwd, "firebase", logger);

    return mapping;
};

export { inferReshape, scanFirebaseDump, scanSupabaseDump };
