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
import { readStorageMetadata } from "./storage-blobs";

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
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new LunoraError("INTERNAL", `${mappingPath}: expected a JSON object`);
    }

    const candidate = raw as Record<string, unknown>;

    if (candidate["keyPrefix"] !== undefined && typeof candidate["keyPrefix"] !== "string") {
        throw new LunoraError("INTERNAL", `${mappingPath}: \`keyPrefix\` must be a string`);
    }

    const columns = candidate["storageColumns"];

    if (columns !== undefined) {
        if (columns === null || typeof columns !== "object" || Array.isArray(columns)) {
            throw new LunoraError("INTERNAL", `${mappingPath}: \`storageColumns\` must be an object of table → column names`);
        }

        for (const [table, value] of Object.entries(columns)) {
            if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
                throw new LunoraError("INTERNAL", `${mappingPath}: \`storageColumns.${table}\` must be an array of column names`);
            }
        }
    }

    return { keyPrefix: candidate["keyPrefix"], storageColumns: columns as Record<string, string[]> | undefined };
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

/** One reference the walk could not rewrite, with where it was found. */
interface UnresolvedStorageReference {
    column: string;
    storageId: string;
    table: string;
}

/**
 * What a run's storage references resolved to. The two failure buckets are
 * deliberately separate, because they are not the same problem and do not have
 * the same remedy:
 *
 * `unmigrated` is a reference to a blob that does not exist — the export omitted
 * it, or `--include-file-storage` was not passed. Nothing the operator writes in
 * a mapping file can fix it, and the data is broken after import, so it fails
 * `--verify`.
 *
 * `ambiguous` is a string that exactly matches a blob that *did* migrate, sitting
 * in a column the mapping does not name. It may be a storage reference the
 * mapping forgot, or it may be user text that happens to equal an id. Failing the
 * run on a coincidence is not defensible, so it warns and names the column the
 * operator would add to resolve it.
 */
interface StorageRemapReport {
    ambiguous: UnresolvedStorageReference[];
    /** Number of references rewritten to a content-hash key. */
    rewritten: number;
    unmigrated: UnresolvedStorageReference[];
}

/**
 * Rewrite storage references in one document against the `storageId → key` map,
 * returning the rewritten document plus what the walk found.
 *
 * `{ $storage: id }` objects are Convex's self-describing Storage value. They are
 * unambiguous, so they are rewritten wherever they occur, at any depth. A plain
 * string is ambiguous against ordinary text, so it is rewritten only under a
 * column `lunora/import-convex.json` names — with no mapping file, no plain
 * string is rewritten at all.
 *
 * The walk is recursive because Convex documents nest freely: a storage id in an
 * array of attachments or inside a nested object is exactly as load-bearing as a
 * top-level one, and skipping it leaves a reference that resolves to nothing
 * while the import still reports success. The **top-level** column name travels
 * down with the walk, so listing `attachments` in the mapping covers every
 * storage id underneath it. That is what makes the mapping a complete answer:
 * `storageColumns` cannot address a nested path, so a nested-only rule would
 * report references the operator had no way to resolve.
 */
const remapStorageReferences = (
    document_: Record<string, unknown>,
    storageIdMap: Map<string, string>,
    table: string,
    storageColumns?: Record<string, string[]>,
): StorageRemapReport & { document: Record<string, unknown> } => {
    const ambiguous: UnresolvedStorageReference[] = [];
    const unmigrated: UnresolvedStorageReference[] = [];
    let rewritten = 0;

    /**
     * Only a column the mapping names. With no mapping file, no plain string is
     * rewritten at all — the operator runs `--scan` to opt columns in. The
     * alternative (treat a missing file as "rewrite everything") inverts the
     * semantics: adding a file would make rewriting *less* aggressive, and
     * deleting a false-positive column from a reviewed mapping would silently
     * restore the rewrite it was deleted to prevent.
     */
    const isMappedColumn = (column: string): boolean => storageColumns?.[table]?.includes(column) === true;

    const remapValue = (value: unknown, column: string, topLevel = false): unknown => {
        if (Array.isArray(value)) {
            return value.map((entry) => remapValue(entry, column, topLevel));
        }

        if (value !== null && typeof value === "object") {
            const record = value as Record<string, unknown>;

            if (typeof record["$storage"] === "string") {
                const storageId = record["$storage"];
                const mappedKey = storageIdMap.get(storageId);

                if (mappedKey === undefined) {
                    unmigrated.push({ column, storageId, table });

                    return value;
                }

                rewritten += 1;

                return mappedKey;
            }

            return Object.fromEntries(Object.entries(record).map(([nested, entry]) => [nested, remapValue(entry, column)]));
        }

        if (typeof value === "string" && storageIdMap.has(value)) {
            if (!isMappedColumn(column)) {
                ambiguous.push({ column, storageId: value, table });

                return value;
            }

            rewritten += 1;

            return storageIdMap.get(value) ?? value;
        }

        // A string in a column the operator DECLARED to hold storage ids, which
        // resolves to no migrated blob — the blob was deleted between the last
        // write and the export, or the export omitted it. The self-describing
        // form gets this check; the declared column is the one the mapping file
        // exists to serve, so it needs it more.
        //
        // Only at the top level: the walk descends into mapped object columns,
        // and flagging every unresolvable string underneath one would bury the
        // real finding in noise. `storageColumns` addresses columns, so that is
        // the depth it can speak about.
        if (topLevel && typeof value === "string" && value.length > 0 && isMappedColumn(column) && storageColumns !== undefined) {
            unmigrated.push({ column, storageId: value, table });
        }

        return value;
    };

    const document = Object.fromEntries(Object.entries(document_).map(([column, value]) => [column, remapValue(value, column, true)]));

    return { ambiguous, document, rewritten, unmigrated };
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

export type { ImportConvexMapping, StorageRemapReport, UnresolvedStorageReference };
export { IMPORT_CONVEX_MAPPING_FILE, readImportConvexMapping, remapStorageReferences, scanStorageColumns };
