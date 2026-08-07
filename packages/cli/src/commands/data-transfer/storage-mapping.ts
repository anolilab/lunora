/**
 * `lunora/import-convex.json`: the operator-confirmed statement of which columns
 * hold Convex storage ids, the rewrite that applies it, and the `--scan` pass
 * that proposes one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../util/logger";
import type { ConvexSnapshot, ConvexSnapshotTable } from "../convex-snapshot";
import { CONVEX_STORAGE_TABLE, isConvexSystemTable, readSnapshotLines } from "../convex-snapshot";
import { assertMappingObject, assertOptionalString, assertOptionalStringArray, isPlainObject } from "./mapping-shapes";
import { readStorageMetadata } from "./storage-blobs";
import { remapStorageReferences } from "./storage-remap";

/** Shape of the `lunora/import-convex.json` mapping file. */
interface ImportConvexMapping {
    keyPrefix?: string;
    storageColumns?: Record<string, string[]>;
}

/** Relative location of the mapping file inside a project. */
const IMPORT_CONVEX_MAPPING_FILE = join("lunora", "import-convex.json");

/**
 * Narrow a parsed mapping file, or throw naming the offending key.
 *
 * A mapping that fails to parse must NOT degrade to "no mapping": the mapping is
 * what tells the importer which plain-string columns hold storage ids, so
 * silently dropping it turns a configured rewrite into a silent no-rewrite and
 * leaves every one of those columns pointing at a Convex id that no longer
 * resolves. Only a *missing* file is optional.
 */
const parseImportConvexMapping = (raw: unknown, mappingPath: string): ImportConvexMapping => {
    const candidate = assertMappingObject(raw, mappingPath);
    const keyPrefix = assertOptionalString(candidate, "keyPrefix", mappingPath);
    const columns = candidate["storageColumns"];

    if (columns !== undefined) {
        if (!isPlainObject(columns)) {
            throw new LunoraError("INTERNAL", `${mappingPath}: \`storageColumns\` must be an object of table → column names`);
        }

        for (const table of Object.keys(columns)) {
            assertOptionalStringArray(columns, table, `${mappingPath}: storageColumns`);
        }
    }

    return { keyPrefix, storageColumns: columns as Record<string, string[]> | undefined };
};

/**
 * Read `lunora/import-convex.json` from the project directory. Returns
 * `undefined` only when the file does not exist; an unreadable or invalid
 * mapping throws.
 */
const readImportConvexMapping = async (cwd: string, logger: Logger): Promise<ImportConvexMapping | undefined> => {
    const mappingPath = join(cwd, IMPORT_CONVEX_MAPPING_FILE);
    let content: string;

    try {
        content = await readFile(mappingPath, "utf8");
    } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") {
            logger.info(`no ${IMPORT_CONVEX_MAPPING_FILE} found — rewriting only self-describing { $storage } refs (run with --scan to generate one)`);

            return undefined;
        }

        throw error;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        throw new LunoraError("INTERNAL", `${mappingPath}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    return parseImportConvexMapping(parsed, mappingPath);
};

/** Parse one scanned line, naming the table and line when it is not JSON. */
const parseScanLine = (line: string, table: string, lineNumber: number): Record<string, unknown> => {
    try {
        return JSON.parse(line) as Record<string, unknown>;
    } catch (error: unknown) {
        throw new LunoraError(
            "INTERNAL",
            `${table}/documents.jsonl line ${String(lineNumber)}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            },
        );
    }
};

/** Columns of one table whose values match a storage id, in first-seen order. */
const scanTableColumns = async (snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable, storageIds: ReadonlySet<string>): Promise<string[]> => {
    // `--scan` IS the rewrite, run as a dry run. Handing `remapStorageReferences`
    // an identity map and no `storageColumns` makes every plain string matching a
    // storage id land in `ambiguous`, tagged with its top-level column — which is
    // exactly the candidate list. `{ $storage }` objects rewrite silently and
    // never appear, which is the special case a separate detector had to
    // hand-code.
    //
    // Sharing the walk is the point: a detector that proposes columns the rewrite
    // would not touch, or misses ones it would, is worse than no detector, and
    // two implementations kept in step by a comment is how that happens.
    const identity = new Map([...storageIds].map((id) => [id, id]));
    const columns: string[] = [];
    let lineNumber = 0;

    for await (const raw of readSnapshotLines(snapshot, tableEntry)) {
        const line = raw.trim();

        lineNumber += 1;

        if (line.length === 0) {
            continue;
        }

        const { ambiguous } = remapStorageReferences(parseScanLine(line, tableEntry.table, lineNumber), identity, tableEntry.table);

        for (const { column } of ambiguous) {
            if (!columns.includes(column)) {
                columns.push(column);
            }
        }
    }

    return columns;
};

/** Walk every application table, collecting the columns that hold storage ids. */
const collectStorageColumns = async (
    snapshot: ConvexSnapshot,
    convexTables: ReadonlyArray<ConvexSnapshotTable>,
    storageIds: ReadonlySet<string>,
): Promise<Record<string, string[]>> => {
    const storageColumns: Record<string, string[]> = {};

    for (const tableEntry of convexTables) {
        if (isConvexSystemTable(tableEntry.table)) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential scan: each table stream is drained before the next
        const columns = await scanTableColumns(snapshot, tableEntry, storageIds);

        if (columns.length > 0) {
            storageColumns[tableEntry.table] = columns;
        }
    }

    return storageColumns;
};

/**
 * Write the candidate mapping, refusing to clobber a confirmed one.
 *
 * `wx` is the whole point: a re-scan of an export whose mapping the operator has
 * already reviewed must not silently replace their edits with fresh guesses.
 */
const writeCandidateMapping = async (mapping: ImportConvexMapping, cwd: string, logger: Logger): Promise<void> => {
    const mappingPath = join(cwd, IMPORT_CONVEX_MAPPING_FILE);
    const serialized = `${JSON.stringify(mapping, undefined, 4)}\n`;

    await mkdir(join(cwd, "lunora"), { recursive: true });

    try {
        await writeFile(mappingPath, serialized, { encoding: "utf8", flag: "wx" });
        logger.success(`wrote candidate mapping to ${mappingPath} — review it, then re-run without --scan`);
    } catch (error: unknown) {
        if ((error as { code?: string }).code !== "EEXIST") {
            throw error;
        }

        logger.warn(`${mappingPath} already exists — leaving it untouched. Candidate mapping:`);
        logger.info(serialized);
    }
};

/**
 * Scan a Convex export for plain-string columns whose values exactly match a
 * `_storage` id, and write the candidate `lunora/import-convex.json` the import
 * consumes.
 *
 * Exact-matching is a *candidate* detector, not an authority: a column of user
 * text could in principle contain a storage id, so the operator confirms the
 * file before the import rewrites anything.
 */
const scanStorageColumns = async (
    snapshot: ConvexSnapshot,
    convexTables: ReadonlyArray<ConvexSnapshotTable>,
    cwd: string,
    logger: Logger,
): Promise<ImportConvexMapping | undefined> => {
    const storageTable = convexTables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

    if (storageTable === undefined) {
        logger.error("no `_storage` table in this export — re-export with `npx convex export --include-file-storage`");

        return undefined;
    }

    const metadataRows = await readStorageMetadata(snapshot, storageTable, logger);
    const storageIds = new Set(metadataRows.map((row) => row.id));

    logger.info(`found ${String(storageIds.size)} storage ids`);

    const mapping: ImportConvexMapping = { keyPrefix: "", storageColumns: await collectStorageColumns(snapshot, convexTables, storageIds) };

    await writeCandidateMapping(mapping, cwd, logger);

    return mapping;
};

export type { ImportConvexMapping };
export { IMPORT_CONVEX_MAPPING_FILE, readImportConvexMapping, scanStorageColumns };
