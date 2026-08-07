/**
 * `lunora import` — read an NDJSON file, or a `npx convex export` snapshot, and
 * POST batches to `POST /_lunora/admin/import`.
 *
 * Authentication mirrors `vis migrate`: an admin bearer via `--token` or
 * `LUNORA_ADMIN_TOKEN`. `--prod` (with an explicit `--url`) is the guardrail
 * against accidentally targeting localhost in production scripts.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { resolveAdminBearer } from "../../util/admin-token";
import { resolveAdminBaseUrl } from "../../util/admin-url";
import type { Logger } from "../../util/logger";
import type { ImportBatcher, ImportTotals } from "./import-batcher";
import { createImportBatcher } from "./import-batcher";
import { createRowTransformer } from "./import-rows";
import type { ImportSource, ImportSourceName } from "./import-source";
import { CONVEX_STORAGE_TABLE, readConvexExport, resolveImportSource } from "./import-source";
import { checkRowParity, reportStorageOutcome, reportUntransferredPaths } from "./import-verify";
import type { StreamingFetchLike } from "./shared";
import { IMPORT_ENDPOINT_PATH } from "./shared";
import { readFirestoreExport } from "./sources/firebase";
import { scanFirebaseDump, scanSupabaseDump } from "./sources/scan";
import { listLocalObjects, listSupabaseObjects, transferStorageObjects } from "./sources/storage-transfer";
import { readSupabaseExport } from "./sources/supabase";
import { migrateStorageBlobs } from "./storage-blobs";
import type { ImportConvexMapping, StorageRemapReport } from "./storage-mapping";
import { readImportConvexMapping, scanStorageColumns } from "./storage-mapping";

const LEADING_SLASH_RE = /^\/+/;

/** Rows per HTTP request when importing. Convex uses ~500; same here. */
const DEFAULT_IMPORT_BATCH_SIZE = 500;

/**
 * Byte ceiling per import POST, held just under the runtime's shared 1 MiB
 * `MAX_BODY_BYTES` that `/_lunora/admin/import` reads under. `--batch-size`
 * counts rows, which says nothing about how wide they are: 500 documents of a
 * few KiB each is an ordinary table and a 413 without this.
 */
const MAX_IMPORT_BATCH_BYTES = 900_000;

interface ImportCommandOptions {
    /** Rows per HTTP request. Defaults to {@link DEFAULT_IMPORT_BATCH_SIZE}. */
    batchSize?: number;
    cwd?: string;
    fetchImpl?: StreamingFetchLike;
    /** Source NDJSON file. Required. */
    file: string;

    /**
     * Which reader to use. Omit to auto-detect between a Convex export snapshot
     * and a plain NDJSON file; `supabase`/`firebase` must be explicit, because a
     * directory of CSV or JSON has no signature that distinguishes it from
     * anything else a user might point at.
     */
    from?: ImportSourceName;
    logger: Logger;
    prod?: boolean;

    /**
     * Scan the export for columns holding `_storage` ids and write a candidate
     * `lunora/import-convex.json`. Scan-only: nothing is imported.
     */
    scan?: boolean;

    /**
     * Local directory of storage objects to migrate alongside the rows — how
     * Firebase Cloud Storage arrives, after `gcloud storage cp -r`.
     */
    storageDir?: string;

    /**
     * Wrap each line as `{table:<name>,doc:<line>}`. Use when the source NDJSON
     * is bare docs from a single table — Convex's `convex import --table users`
     * shape.
     */
    table?: string;
    token?: string;

    url?: string;

    /**
     * Verify per-table row parity + dangling-storage after import. Exits non-zero
     * when a table's inserted count differs from its source line count, or when a
     * document references a storage id that was not migrated.
     */
    verify?: boolean;

    /**
     * Also migrate Convex `_storage` blobs: read `_storage/documents.jsonl`, upload
     * each blob with sha256+size verification, and build the `storageId → key` map.
     * Off by default so the plain-document import path is unchanged.
     */
    withStorage?: boolean;

    /** Confirm bulk-writing production. Required alongside `--prod`. */
    yes?: boolean;
}

interface ImportCommandResult {
    body: unknown;
    code: number;
    /** Total inserted rows across batches. */
    inserted: number;
}

interface ImportRequest {
    /** Worker origin — the storage phase hangs its own routes off it. */
    baseUrl: string;
    fetchImpl: StreamingFetchLike;
    requestUrl: string;
    token: string;
}

/**
 * Validate `import` preconditions (guardrails, token, source file, fetch) and
 * resolve the request context. Returns `undefined` after logging when any
 * precondition fails, so the caller can exit non-zero.
 */
const resolveImportRequest = async (options: ImportCommandOptions): Promise<ImportRequest | undefined> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to import to the implicit localhost worker)");

        return undefined;
    }

    if (options.prod && options.yes !== true) {
        options.logger.error("import --prod bulk-writes production. Re-run with --yes to confirm.");

        return undefined;
    }

    // Resolved before the token so the `.dev.vars` fallback is gated on the
    // request's real destination rather than on the (possibly absent) flag.
    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return undefined;
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return undefined;
    }

    try {
        const stats = await stat(options.file);

        // A directory is allowed: it is how a `npx convex export --path <dir>`
        // dump arrives, and `readConvexExport` streams it. Anything that is
        // neither a file nor a directory (a socket, a device) is not.
        if (!stats.isFile() && !stats.isDirectory()) {
            options.logger.error(`not a file or directory: ${options.file}`);

            return undefined;
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(`failed to stat ${options.file}: ${message}`);

        return undefined;
    }

    const fetchImpl = (options.fetchImpl ?? (globalThis as unknown as { fetch: StreamingFetchLike }).fetch) as StreamingFetchLike | undefined;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    return { baseUrl, fetchImpl, requestUrl: `${baseUrl}${IMPORT_ENDPOINT_PATH}`, token };
};

/**
 * The machine-readable run summary. The storage block is present only when blobs
 * were migrated, so a plain import's output shape is unchanged.
 */
const buildImportBody = (totals: ImportTotals, storageIdMap: Map<string, string> | undefined, report: StorageRemapReport): Record<string, unknown> => {
    return {
        conflicts: totals.conflicts,
        errors: totals.errors,
        inserted: totals.inserted,
        received: totals.received,
        ...(storageIdMap === undefined
            ? {}
            : { storage: { ambiguous: report.ambiguous, blobs: storageIdMap.size, rewritten: report.rewritten, unmigrated: report.unmigrated } }),
        ...(totals.warnings.length > 0 ? { warnings: totals.warnings } : {}),
    };
};

/** Pick the reader for the resolved source. Every branch yields the same `{ table, doc }` NDJSON. */
const openSourceStream = (
    source: ImportSource,
    options: ImportCommandOptions,
    storageMigrated: boolean,
    sourceRows: Map<string, number>,
): AsyncIterable<Buffer | string> => {
    switch (source.kind) {
        case "convex": {
            return readConvexExport(source.snapshot, source.tables, options.logger, storageMigrated, sourceRows);
        }

        case "firebase": {
            return readFirestoreExport(source.collections, source.mapping, options.logger, sourceRows, options.file);
        }

        case "supabase": {
            return readSupabaseExport(source.tables, source.mapping, options.logger, sourceRows, options.file);
        }

        default: {
            return createReadStream(options.file, { encoding: "utf8" });
        }
    }
};

/**
 * Propose a mapping for whichever source this is, writing it for review.
 *
 * Scan-only, and it runs before the worker/token preconditions: an operator
 * inspects a dump long before a target worker exists.
 */
const runScan = async (source: ImportSource, cwd: string, logger: Logger): Promise<unknown> => {
    switch (source.kind) {
        case "convex": {
            return scanStorageColumns(source.snapshot, source.tables, cwd, logger);
        }

        case "firebase": {
            return scanFirebaseDump(source.collections, cwd, logger);
        }

        case "supabase": {
            return scanSupabaseDump(source.tables, cwd, logger);
        }

        default: {
            logger.error("--scan needs a Convex, Supabase, or Firebase source.");

            return undefined;
        }
    }
};

/**
 * Move a foreign bucket into R2 and return the `sourcePath → R2 key` map.
 *
 * The Supabase service-role key is read from the environment rather than taken
 * as a flag: it grants full read/write on the project, and a flag puts it in the
 * process table where any other local process can read it. The `--token` option
 * carries the same warning for the same reason.
 */
const runForeignStorageTransfer = async (
    context: { baseUrl: string; fetchImpl: StreamingFetchLike; token: string },
    source: Extract<ImportSource, { kind: "firebase" | "supabase" }>,
    options: ImportCommandOptions,
    cwd: string,
): Promise<Map<string, string> | undefined> => {
    const keyPrefix = source.mapping?.keyPrefix ?? "";

    if (options.storageDir !== undefined) {
        return transferStorageObjects(context, await listLocalObjects(options.storageDir), { cwd, keyPrefix, source: source.kind }, options.logger);
    }

    const url = process.env["SUPABASE_URL"];
    const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

    if (url === undefined || serviceKey === undefined) {
        options.logger.error(
            "--with-storage needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (the service-role key, not the anon key), or --storage-dir pointing at an already-downloaded bucket.",
        );

        return undefined;
    }

    let end = url.length;

    while (end > 0 && url[end - 1] === "/") {
        end -= 1;
    }

    const objects = await listSupabaseObjects({ serviceKey, url: url.slice(0, end) }, context.fetchImpl, options.logger);

    return transferStorageObjects(context, objects, { cwd, keyPrefix, source: source.kind }, options.logger);
};

/**
 * Rewrite the columns a mapping names from their provider-side path to the R2
 * key the object landed under.
 *
 * A path the transfer never saw is left alone and reported, not guessed — the
 * same rule the Convex importer applies to an unresolvable storage reference.
 */
const remapStoragePaths = (
    document_: Record<string, unknown>,
    table: string,
    transferred: Map<string, string>,
    source: Extract<ImportSource, { kind: "firebase" | "supabase" }>,
    unresolved: Set<string>,
): Record<string, unknown> => {
    const columns = source.mapping?.tables?.[table]?.storageColumns ?? [];

    if (columns.length === 0) {
        return document_;
    }

    const remapped = { ...document_ };

    for (const column of columns) {
        const value = remapped[column];

        if (typeof value !== "string" || value.length === 0) {
            continue;
        }

        const key = transferred.get(value) ?? transferred.get(value.replace(LEADING_SLASH_RE, ""));

        if (key === undefined) {
            unresolved.add(`${table}.${column}: ${value}`);
        } else {
            remapped[column] = key;
        }
    }

    return remapped;
};

/**
 * The line→row transform for a run, with the foreign-source path rewrite layered
 * on top of the Convex storage-reference rewrite.
 *
 * They are separate passes because they answer different questions: one rewrites
 * a Convex storage id to a content-hash key, the other rewrites a provider-side
 * object path to one. A run only ever needs one of them.
 */
const createSourceRowTransformer = (config: {
    report: StorageRemapReport;
    source: ImportSource;
    storageColumns?: Record<string, string[]>;
    storageIdMap?: Map<string, string>;
    table?: string;
    transferredPaths?: Map<string, string>;
    unresolvedPaths: Set<string>;
}): ((line: string, lineNumber: number) => string | undefined) => {
    const toWireRow = createRowTransformer({
        report: config.report,
        storageColumns: config.storageColumns,
        storageIdMap: config.storageIdMap,
        table: config.table,
    });

    const foreignSource = config.source.kind === "supabase" || config.source.kind === "firebase" ? config.source : undefined;
    const { transferredPaths } = config;

    if (transferredPaths === undefined || foreignSource === undefined) {
        return toWireRow;
    }

    return (line: string, lineNumber: number): string | undefined => {
        const row = toWireRow(line, lineNumber);

        if (row === undefined) {
            return undefined;
        }

        const parsed = JSON.parse(row) as { doc: Record<string, unknown>; table: string };

        return JSON.stringify({ ...parsed, doc: remapStoragePaths(parsed.doc, parsed.table, transferredPaths, foreignSource, config.unresolvedPaths) });
    };
};

/**
 * Feed a source's text chunks through the row transform into the batcher,
 * returning the error that stopped it (or `undefined`).
 *
 * `for await ... of` awaits each chunk and propagates errors through the
 * surrounding async function, and backpressure falls out of that `await` — the
 * loop only requests the next chunk once the current one is drained.
 *
 * A mid-stream failure is returned rather than thrown: a bulk import that dies
 * on batch 900 of 2,000 has already written 899 batches, and the operator needs
 * to know how far it got before deciding whether to resume. Letting the error
 * escape prints one line and discards every tally.
 */
const drainIntoBatcher = async (
    stream: AsyncIterable<Buffer | string>,
    toWireRow: (line: string, lineNumber: number) => string | undefined,
    batcher: ImportBatcher,
    logger: Logger,
): Promise<unknown> => {
    let buffer = "";
    let lineNumber = 0;

    const feed = async (line: string): Promise<void> => {
        lineNumber += 1;

        const row = toWireRow(line, lineNumber);

        if (row !== undefined) {
            await batcher.push(row);
        }
    };

    try {
        for await (const chunk of stream) {
            buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

            let newlineIndex = buffer.indexOf("\n");

            while (newlineIndex !== -1) {
                // eslint-disable-next-line no-await-in-loop -- rows are fed in order; the batcher POSTs when full
                await feed(buffer.slice(0, newlineIndex));
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf("\n");
            }
        }

        if (buffer.length > 0) {
            await feed(buffer);
        }

        await batcher.flush();

        return undefined;
    } catch (error: unknown) {
        logger.error(`import failed part-way through: ${error instanceof Error ? error.message : String(error)}`);
        logger.error("the rows below had already been written — re-run the same command to resume (existing rows conflict rather than duplicate)");

        return error;
    }
};

/**
 * Upload every `_storage` blob and build the `storageId → R2 key` map the
 * document rewrite needs. Returns `undefined` after logging when the export
 * cannot support the request.
 */
const runStorageMigration = async (
    context: { baseUrl: string; fetchImpl: StreamingFetchLike; token: string },
    source: Extract<ImportSource, { kind: "convex" }>,
    cwd: string,
    logger: Logger,
): Promise<undefined | { mapping?: ImportConvexMapping; storageIdMap: Map<string, string> }> => {
    const mapping = await readImportConvexMapping(cwd, logger);
    const storageTableEntry = source.tables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

    if (storageTableEntry === undefined) {
        logger.error("--with-storage requires a Convex export with a `_storage` metadata table — re-export with `npx convex export --include-file-storage`.");

        return undefined;
    }

    const storageIdMap = await migrateStorageBlobs(context, source.snapshot, storageTableEntry, mapping?.keyPrefix ?? "", logger);

    logger.info(`storage map: ${String(storageIdMap.size)} blobs mapped`);

    return { mapping, storageIdMap };
};

/**
 * Run whichever storage phase this source has, or none.
 *
 * Convex carries its blobs inside the export; Supabase and Firebase keep theirs
 * in a bucket that has to be walked. Both end at the same place — a map from the
 * old reference to the new R2 key — so the caller does not care which ran.
 */
const runStoragePhase = async (
    context: { baseUrl: string; fetchImpl: StreamingFetchLike; token: string },
    source: ImportSource,
    options: ImportCommandOptions,
    cwd: string,
): Promise<undefined | { mapping?: ImportConvexMapping; storageIdMap?: Map<string, string>; transferredPaths?: Map<string, string> }> => {
    if (options.withStorage !== true) {
        return {};
    }

    if (source.kind === "convex") {
        return runStorageMigration(context, source, cwd, options.logger);
    }

    if (source.kind !== "supabase" && source.kind !== "firebase") {
        return {};
    }

    try {
        const transferredPaths = await runForeignStorageTransfer(context, source, options, cwd);

        return transferredPaths === undefined ? undefined : { transferredPaths };
    } catch {
        // The transfer already reported which object failed and that the
        // checkpoint is saved. Rows are deliberately NOT imported after a
        // partial transfer: every path column would point at an object that is
        // not there yet, which is the dangling reference the files-first
        // ordering exists to prevent.
        options.logger.error("no rows were imported — fix the transfer and re-run; it will resume where it stopped");

        return undefined;
    }
};

/**
 * Print an import run's diagnostics and summary.
 *
 * `received` versus the inserted total is what distinguishes "wrote nothing
 * because there was nothing" from "wrote nothing because I could not" — the
 * distinction the endpoint's success-shaped empty response used to hide.
 */
const reportImportOutcome = (
    logger: Logger,
    outcome: { conflicts: number; errorCount: number; insertedTotal: number; received: number; warnings: ReadonlyArray<string> },
): void => {
    for (const warning of outcome.warnings) {
        logger.warn(warning);
    }

    const unaccounted = outcome.received - outcome.insertedTotal - outcome.conflicts - outcome.errorCount;

    if (unaccounted > 0) {
        logger.warn(`${String(unaccounted)} of ${String(outcome.received)} rows were neither inserted, conflicted, nor reported as errors`);
    }

    logger.success(
        `imported ${String(outcome.insertedTotal)} of ${String(outcome.received)} rows (${String(outcome.conflicts)} conflicts, ${String(outcome.errorCount)} errors)`,
    );
};

const runImportCommand = async (options: ImportCommandOptions): Promise<ImportCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const source = await resolveImportSource(options, cwd);

    if (source.kind === "invalid") {
        return { body: undefined, code: 1, inserted: 0 };
    }

    // Scan-only: it writes the candidate mapping and imports nothing, so it runs
    // before the worker/token preconditions — the operator inspects an export
    // long before a target worker exists.
    if (options.scan === true) {
        const scanned = await runScan(source, cwd, options.logger);

        return { body: scanned, code: scanned === undefined ? 1 : 0, inserted: 0 };
    }

    const request = await resolveImportRequest(options);

    if (request === undefined) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const { baseUrl, fetchImpl, requestUrl, token } = request;
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;

    // Phase 1: move the files first, so no imported document can reference an
    // object that is not there yet.
    const storage = await runStoragePhase({ baseUrl, fetchImpl, token }, source, options, cwd);

    if (storage === undefined) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const { mapping, storageIdMap, transferredPaths } = storage;
    const unresolvedPaths = new Set<string>();
    const storageColumns = mapping?.storageColumns;
    const remapReport: StorageRemapReport = { ambiguous: [], rewritten: 0, unmigrated: [] };

    options.logger.info(
        source.kind === "convex"
            ? `POST ${requestUrl} -> import Convex export ${options.file} (${String(source.tables.length)} tables)`
            : `POST ${requestUrl} -> import ${options.file}`,
    );

    // Both sources are `for await`-able chunks of text, so the same buffering +
    // batching loop below drives either one, and the in-memory cost stays bounded
    // by `batchSize` rather than by the size of the source.
    //
    // The Convex reader tallies what it emits into `sourceRows` as it goes; the
    // parity check after the run compares that against what the endpoint says it
    // inserted.
    const sourceRows = new Map<string, number>();
    const stream = openSourceStream(source, options, storageIdMap !== undefined, sourceRows);
    const batcher = createImportBatcher({ batchSize, fetchImpl, maxBatchBytes: MAX_IMPORT_BATCH_BYTES, requestUrl, token });
    const toRow = createSourceRowTransformer({
        report: remapReport,
        source,
        storageColumns,
        storageIdMap,
        table: options.table,
        transferredPaths,
        unresolvedPaths,
    });

    const streamFailure = await drainIntoBatcher(stream, toRow, batcher, options.logger);

    const { conflicts, errors, inserted, received, warnings } = batcher.totals;

    // Parity over an aborted run only restates the abort, so skip it there and
    // let the failure be the verdict.
    const parityMismatch = options.verify === true && streamFailure === undefined ? checkRowParity(options.logger, sourceRows, { conflicts, inserted }) : 0;
    const unmigratedFailure = storageIdMap !== undefined && reportStorageOutcome(options.logger, remapReport, options.verify === true);

    const unresolvedPathFailure = reportUntransferredPaths(options.logger, unresolvedPaths, options.verify === true);

    const insertedTotal = Object.values(inserted).reduce((a, b) => a + b, 0);
    const body = buildImportBody(batcher.totals, storageIdMap, remapReport);

    options.logger.info(JSON.stringify(body, undefined, 2));
    reportImportOutcome(options.logger, { conflicts, errorCount: errors.length, insertedTotal, received, warnings });

    const failed = streamFailure !== undefined || errors.length > 0 || parityMismatch > 0 || unmigratedFailure || unresolvedPathFailure;

    return { body, code: failed ? 1 : 0, inserted: insertedTotal };
};

export type { ImportCommandOptions, ImportCommandResult };
export { DEFAULT_IMPORT_BATCH_SIZE, runImportCommand };
