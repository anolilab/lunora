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

import { resolveAdminBearer, targetsRemoteWorker } from "../../util/admin-token";
import { adminFetch, resolveAdminBaseUrl } from "../../util/admin-url";
import type { Refusal } from "../../util/exit-code";
import { EXIT_CODE, isRefusal } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { CommandResult, OutputFormat } from "../../util/output-format";
import { CONVEX_STORAGE_TABLE } from "../convex-snapshot";
import type { ImportBatcher, ImportRowError, ImportShardFailure, ImportTotals } from "./import-batcher";
import { createImportBatcher } from "./import-batcher";
import { createRowTransformer } from "./import-rows";
import type { ImportSource, ImportSourceName } from "./import-source";
import { readConvexExport, resolveImportSource } from "./import-source";
import { checkRowParity, reportStorageOutcome, reportUntransferredPaths, UNRESOLVED_REPORT_LIMIT } from "./import-verify";
import type { StreamingFetchLike } from "./shared";
import { IMPORT_ENDPOINT_PATH } from "./shared";
import { readFirestoreExport } from "./sources/firebase";
import { scanFirebaseDump, scanSupabaseDump } from "./sources/scan";
import { listLocalObjects, listSupabaseObjects, transferStorageObjects } from "./sources/storage-transfer";
import { readSupabaseExport } from "./sources/supabase";
import { migrateStorageBlobs, readStorageBlobKeys } from "./storage-blobs";
import type { ImportConvexMapping } from "./storage-mapping";
import { readImportConvexMapping, scanStorageColumns } from "./storage-mapping";
import type { StoragePathIndex } from "./storage-path-index";
import { indexTransferredPaths, resolveStoragePath } from "./storage-path-index";
import type { StorageRemapReport } from "./storage-remap";

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
    /** Output format: `pretty` (default) or `json`. */
    format?: OutputFormat;

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

/**
 * The JSON summary a run prints and returns — the same object either way, so a
 * caller reading `body.conflicts` does not have to cast its way there.
 *
 * `undefined` on every path that imports nothing: a rejected source, a failed
 * storage phase, or `--scan` (whose product is the mapping file it writes, not
 * a return value).
 */
interface ImportSummary {
    conflicts: number;
    errors: ImportRowError[];
    /** Shards the endpoint could not reach (it answered 207). Their rows are MISSING, not rejected — present only when non-empty. */
    failed?: ImportShardFailure[];
    inserted: Record<string, number>;
    received: number;
    storage?: {
        /** Up to {@link UNRESOLVED_REPORT_LIMIT} distinct references — a sample, not the whole set. See `ambiguousTotal`. */
        ambiguous: StorageRemapReport["ambiguous"];
        /** How many DISTINCT `(table, column, storageId)` references were ambiguous. */
        ambiguousTotal: number;
        blobs: number;
        rewritten: number;
        /** Up to {@link UNRESOLVED_REPORT_LIMIT} distinct references — a sample, not the whole set. See `unmigratedTotal`. */
        unmigrated: StorageRemapReport["unmigrated"];
        /** How many DISTINCT `(table, column, storageId)` references resolved to no migrated blob. */
        unmigratedTotal: number;
    };
    warnings?: string[];
}

/** The `--format json` payload: which file went in, and what the endpoint made of it. */
interface ImportCommandData {
    file: string;
    inserted: number;
    /** The batcher's own roll-up: inserted-per-table, conflicts, row errors, unreached shards. */
    summary: ImportSummary;
}

interface ImportCommandResult extends CommandResult<ImportCommandData> {
    body: ImportSummary | undefined;
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
 * resolve the request context. Logs the reason and returns a {@link Refusal}
 * carrying its exit code when any precondition fails — the reasons land in
 * different buckets (a flag combination is usage, a missing bearer is auth), and
 * a bare `undefined` left the caller unable to tell them apart.
 */
const resolveImportRequest = async (options: ImportCommandOptions): Promise<ImportRequest | Refusal> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to import to the implicit localhost worker)");

        return { refused: EXIT_CODE.USAGE };
    }

    // Resolved before the token so the `.dev.vars` fallback is gated on the
    // request's real destination rather than on the (possibly absent) flag.
    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        // `resolveAdminBaseUrl` logged an invalid `--url`, or its refusal to put a
        // bearer on the wire in cleartext — both are the target you named.
        return { refused: EXIT_CODE.USAGE };
    }

    // Gated on the RESOLVED destination, not on `--prod`: the flag is a
    // self-declaration, and a bulk write to `--url https://…` without it is
    // just as destructive.
    if (targetsRemoteWorker({ prod: options.prod, url: baseUrl }) && options.yes !== true) {
        options.logger.error(`import bulk-writes ${baseUrl}, which is not local. Re-run with --yes to confirm.`);

        return { refused: EXIT_CODE.USAGE };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return { refused: EXIT_CODE.AUTH };
    }

    try {
        const stats = await stat(options.file);

        // A directory is allowed: it is how a `npx convex export --path <dir>`
        // dump arrives, and `readConvexExport` streams it. Anything that is
        // neither a file nor a directory (a socket, a device) is not.
        if (!stats.isFile() && !stats.isDirectory()) {
            options.logger.error(`not a file or directory: ${options.file}`);

            return { refused: EXIT_CODE.USAGE };
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(`failed to stat ${options.file}: ${message}`);

        // The path the invocation named is not readable — most often not there.
        return { refused: EXIT_CODE.NOT_FOUND };
    }

    const fetchImpl = options.fetchImpl ?? adminFetch;

    return { baseUrl, fetchImpl, requestUrl: `${baseUrl}${IMPORT_ENDPOINT_PATH}`, token };
};

/**
 * The machine-readable run summary. The storage block is present only when blobs
 * were migrated, so a plain import's output shape is unchanged.
 */
const buildImportBody = (totals: ImportTotals, storageIdMap: Map<string, string> | undefined, report: StorageRemapReport): ImportSummary => {
    return {
        conflicts: totals.conflicts,
        errors: totals.errors,
        ...(totals.failed.length > 0 ? { failed: totals.failed } : {}),
        inserted: totals.inserted,
        received: totals.received,
        // A SAMPLE plus the totals, never the whole arrays: an unmapped 200k-row
        // import produced tens of thousands of distinct references and pushed a
        // multi-megabyte blob through one `logger.info`, burying the summary the
        // display cap exists to protect. The `*Total` fields carry the real counts.
        ...(storageIdMap === undefined
            ? {}
            : {
                  storage: {
                      ambiguous: report.ambiguous.slice(0, UNRESOLVED_REPORT_LIMIT),
                      ambiguousTotal: report.ambiguous.length,
                      blobs: storageIdMap.size,
                      rewritten: report.rewritten,
                      unmigrated: report.unmigrated.slice(0, UNRESOLVED_REPORT_LIMIT),
                      unmigratedTotal: report.unmigrated.length,
                  },
              }),
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

    // Everything below downloads from Supabase Storage. There is no remote
    // Firebase path — a Cloud Storage bucket is pulled with `gcloud`/`gsutil`
    // first — so a Firebase run reaching here must say that, rather than
    // reporting a missing SUPABASE_URL for a migration that has no Supabase in
    // it.
    if (source.kind === "firebase") {
        options.logger.error(
            "--with-storage needs --storage-dir for a Firebase source: download the bucket first " +
                "(`gcloud storage cp -r gs://<bucket> ./storage`), then point --storage-dir at it.",
        );

        return undefined;
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

    const projectUrl = url.slice(0, end);

    // The service-role key travels as a Bearer on every request. Over plain HTTP
    // that is the whole credential in cleartext, so refuse rather than warn.
    if (!projectUrl.startsWith("https://")) {
        options.logger.error(`SUPABASE_URL must be https:// — refusing to send the service-role key over ${projectUrl.split(":")[0] ?? "an unknown scheme"}.`);

        return undefined;
    }

    const objects = await listSupabaseObjects({ serviceKey, url: projectUrl }, context.fetchImpl, options.logger);

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
    transferred: StoragePathIndex,
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

        const key = resolveStoragePath(value, transferred);

        if (key === undefined) {
            unresolved.add(`${table}.${column}: ${value}`);
        } else {
            remapped[column] = key;
        }
    }

    return remapped;
};

/**
 * The line→row transform for a run, with the foreign-source path rewrite
 * supplied to the row transformer as a hook.
 *
 * The two rewrites answer different questions — one turns a Convex storage id
 * into a content-hash key, the other turns a provider-side object path into one
 * — and a run only ever needs one of them. They share a hook rather than
 * stacking as two transforms so a row is parsed and serialised once.
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
    const foreignSource = config.source.kind === "supabase" || config.source.kind === "firebase" ? config.source : undefined;
    const { transferredPaths } = config;

    // Indexed once per run, not once per row: the alternate spellings a column
    // may hold are a property of the transfer, and rebuilding them per document
    // would make the rewrite quadratic in the object count.
    const pathIndex = transferredPaths === undefined || foreignSource === undefined ? undefined : indexTransferredPaths(transferredPaths);

    return createRowTransformer({
        remapDocument:
            pathIndex === undefined || foreignSource === undefined
                ? undefined
                : (document, table): Record<string, unknown> => remapStoragePaths(document, table, pathIndex, foreignSource, config.unresolvedPaths),
        report: config.report,
        storageColumns: config.storageColumns,
        storageIdMap: config.storageIdMap,
        table: config.table,
    });
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
        const message = error instanceof Error ? error.message : String(error);

        // `received` grows only once a batch's response is read, so zero means no
        // write was CONFIRMED, not that none landed: a batch the server committed
        // and then lost the connection on still counts zero here.
        if (batcher.totals.received === 0) {
            logger.error(`import failed before any batch was acknowledged: ${message}`);
            logger.error("re-run the same command once the worker is reachable (existing rows conflict rather than duplicate)");
        } else {
            logger.error(`import failed part-way through: ${message}`);
            logger.error("the rows below had already been written — re-run the same command to resume (existing rows conflict rather than duplicate)");
        }

        return error;
    }
};

/** What the document rewrite needs from the storage phase, worked out before any blob moves. */
interface StoragePlan {
    mapping?: ImportConvexMapping;
    /** Convex only: the `storageId → R2 key` map, derived from the metadata, so it is exact before the upload runs. */
    storageIdMap?: Map<string, string>;
}

/**
 * The storage facts the check needs, read without moving a byte.
 *
 * A Convex blob's key is its content hash, so the map is known from the
 * metadata alone. The check must rewrite with it: an unrewritten
 * `{ $storage }` reference is an object, and the worker refuses it where the
 * real pass sends a string. Foreign sources have no such map, because their
 * keys only exist after the transfer, but their rewrite only swaps one string
 * for another, so the check's verdict does not depend on it.
 */
const planStoragePhase = async (source: ImportSource, options: ImportCommandOptions, cwd: string): Promise<undefined | StoragePlan> => {
    if (options.withStorage !== true || source.kind !== "convex") {
        return {};
    }

    const mapping = await readImportConvexMapping(cwd, options.logger);
    const storageTableEntry = source.tables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

    if (storageTableEntry === undefined) {
        options.logger.error(
            "--with-storage requires a Convex export with a `_storage` metadata table — re-export with `npx convex export --include-file-storage`.",
        );

        return undefined;
    }

    return { mapping, storageIdMap: await readStorageBlobKeys(source.snapshot, storageTableEntry, mapping?.keyPrefix ?? "", options.logger) };
};

/**
 * Upload every `_storage` blob. The map it returns is the one the plan already
 * derived, built from the same keys, so the rows the check rewrote and the rows
 * the real pass rewrites agree. Returns `undefined` when the export has no
 * `_storage` table, which `planStoragePhase` has already refused and logged.
 */
const runStorageMigration = async (
    context: { baseUrl: string; fetchImpl: StreamingFetchLike; token: string },
    source: Extract<ImportSource, { kind: "convex" }>,
    plan: StoragePlan,
    logger: Logger,
): Promise<undefined | { mapping?: ImportConvexMapping; storageIdMap: Map<string, string> }> => {
    const storageTableEntry = source.tables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

    if (storageTableEntry === undefined) {
        return undefined;
    }

    const storageIdMap = await migrateStorageBlobs(context, source.snapshot, storageTableEntry, plan.mapping?.keyPrefix ?? "", logger);

    logger.info(`storage map: ${String(storageIdMap.size)} blobs mapped`);

    return { mapping: plan.mapping, storageIdMap };
};

/**
 * Run whichever storage phase this source has, or none. Runs only after the
 * check has passed the file, so a refused import uploads nothing.
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
    plan: StoragePlan,
): Promise<undefined | { mapping?: ImportConvexMapping; storageIdMap?: Map<string, string>; transferredPaths?: Map<string, string> }> => {
    if (options.withStorage !== true) {
        return {};
    }

    if (source.kind === "convex") {
        return runStorageMigration(context, source, plan, options.logger);
    }

    if (source.kind !== "supabase" && source.kind !== "firebase") {
        return {};
    }

    try {
        const transferredPaths = await runForeignStorageTransfer(context, source, options, cwd);

        return transferredPaths === undefined ? undefined : { transferredPaths };
    } catch (error: unknown) {
        // The error is REPORTED, not discarded. Only one throw site inside the
        // transfer logs before rethrowing (the per-object failure); every other
        // reachable one — a bucket list refused because the anon key was supplied
        // instead of the service-role key, an unreachable project URL — arrived
        // here silently and the whole output became one fixed line, destroying the
        // diagnostic that named the cause.
        options.logger.error(`storage transfer failed: ${error instanceof Error ? error.message : String(error)}`);

        // Rows are deliberately NOT imported after a partial transfer: every path
        // column would point at an object that is not there yet, which is the
        // dangling reference the files-first ordering exists to prevent.
        //
        // The re-run advice does not promise a checkpoint: a failure before the
        // first object moved has none to resume from, and the old wording told the
        // operator to expect one anyway.
        options.logger.error("no rows were imported — fix the error above and re-run; objects that did transfer are checkpointed and will be skipped");

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
    outcome: { conflicts: number; errorCount: number; failed: boolean; insertedTotal: number; received: number; warnings: ReadonlyArray<string> },
): void => {
    for (const warning of outcome.warnings) {
        logger.warn(warning);
    }

    const unaccounted = outcome.received - outcome.insertedTotal - outcome.conflicts - outcome.errorCount;

    if (unaccounted > 0) {
        logger.warn(`${String(unaccounted)} of ${String(outcome.received)} rows were neither inserted, conflicted, nor reported as errors`);
    }

    const summary = `imported ${String(outcome.insertedTotal)} of ${String(outcome.received)} rows (${String(outcome.conflicts)} conflicts, ${String(outcome.errorCount)} errors)`;

    // A run that exits 1 must not end on a green line — the summary is the last
    // thing an operator reads, and only the exit code disagreed with it.
    if (outcome.failed) {
        logger.error(summary);
    } else {
        logger.success(summary);
    }
};

/**
 * `--scan`: write the candidate storage-column mapping and import nothing. Its
 * product is the file it wrote, so there is no import summary to hand back.
 */
const scanOnly = async (source: ImportSource, cwd: string, options: ImportCommandOptions): Promise<ImportCommandResult> => {
    const scanned = await runScan(source, cwd, options.logger);

    if (scanned === undefined) {
        return { body: undefined, code: EXIT_CODE.USAGE, error: "import --scan: the export could not be scanned", inserted: 0 };
    }

    return { body: undefined, code: 0, inserted: 0 };
};

/** The storage phase's result: the storage mapping and the `storageId → R2 key` map the row rewrite reads. */
type StoragePhaseResult = NonNullable<Awaited<ReturnType<typeof runStoragePhase>>>;

/** Where a pass POSTs its batches, and how many rows each may carry. */
interface ImportPassTarget {
    batchSize: number;
    fetchImpl: StreamingFetchLike;
    requestUrl: string;
    token: string;
}

/** What one pass over the source produced. Each pass keeps its own counters, so a check never shares a tally with the real pass. */
interface ImportPass {
    batcher: ImportBatcher;
    remapReport: StorageRemapReport;
    sourceRows: Map<string, number>;
    streamFailure: unknown;
    unresolvedPaths: Set<string>;
}

/**
 * The code a worker gives a global row it cannot check without writing. A check cannot judge such a row, so the refusal is not a reason to
 * stop: the real pass writes it, as it did before the check existed.
 */
const GLOBAL_DRY_RUN_UNSUPPORTED = "GLOBAL_DRY_RUN_UNSUPPORTED";

const quietLogger: Logger = { error: () => undefined, info: () => undefined, success: () => undefined, warn: () => undefined };

/** The options a check runs with: the same source and flags, and no narration, since the real pass narrates the same rows. */
const quietOptions = (options: ImportCommandOptions): ImportCommandOptions => {
    return { ...options, logger: quietLogger };
};

/**
 * Read the source once and POST its rows in batches of `target`. The Convex reader tallies what it emits into `sourceRows` as it goes; the
 * parity check after the run compares that against what the endpoint says it inserted. Only the Convex directory and Supabase CSV readers
 * stream the source itself; the ZIP and Firestore readers materialise one table at a time.
 */
const runImportPass = async (
    options: ImportCommandOptions,
    source: ImportSource,
    storage: StoragePhaseResult,
    target: ImportPassTarget,
): Promise<ImportPass> => {
    const unresolvedPaths = new Set<string>();
    const remapReport: StorageRemapReport = { ambiguous: [], rewritten: 0, unmigrated: [] };
    const sourceRows = new Map<string, number>();
    const stream = openSourceStream(source, options, storage.storageIdMap !== undefined, sourceRows);
    const batcher = createImportBatcher({
        batchSize: target.batchSize,
        fetchImpl: target.fetchImpl,
        maxBatchBytes: MAX_IMPORT_BATCH_BYTES,
        requestUrl: target.requestUrl,
        token: target.token,
    });
    const toRow = createSourceRowTransformer({
        report: remapReport,
        source,
        storageColumns: storage.mapping?.storageColumns,
        storageIdMap: storage.storageIdMap,
        table: options.table,
        transferredPaths: storage.transferredPaths,
        unresolvedPaths,
    });
    // Every source is a `for await`-able of text, so one drain loop drives all of
    // them and the POST size stays bounded by `batchSize`.
    const streamFailure = await drainIntoBatcher(stream, toRow, batcher, options.logger);

    return { batcher, remapReport, sourceRows, streamFailure, unresolvedPaths };
};

/** The message of a failure the stream or the batcher raised. A value that is not an Error is named as it is. */
const failureMessage = (failure: unknown): string => {
    if (failure instanceof Error) {
        return failure.message;
    }

    return typeof failure === "string" ? failure : "an unknown failure";
};

/**
 * Whether the check met a row the shard already holds: one the worker reported as written, or an `_id` it found in use. A check writes nothing,
 * so either means the worker ignored the dry-run flag or already has the row.
 */
const checkMetWrites = (check: ImportPass): boolean => {
    const { conflicts, inserted } = check.batcher.totals;

    return conflicts > 0 || Object.values(inserted).some((count) => count > 0);
};

/**
 * The result of a check that refuses the file: the check's own report, the reason it refused, and nothing written. Each shard the check
 * could not reach and a stream failure are named here, as the real pass names them.
 */
const refuseFile = (options: ImportCommandOptions, check: ImportPass, refusal: string, storageIdMap: Map<string, string> | undefined): ImportCommandResult => {
    const body = buildImportBody(check.batcher.totals, storageIdMap, check.remapReport);
    const checkWrote = checkMetWrites(check);

    // Pretty mode only: in json the same object is the document's `summary`.
    if (options.format !== "json") {
        options.logger.info(JSON.stringify(body, undefined, 2));
    }

    if (check.streamFailure !== undefined) {
        const message = failureMessage(check.streamFailure);

        options.logger.error(
            check.batcher.totals.received === 0
                ? `import failed before any batch was acknowledged: ${message}`
                : `import failed while checking the rows: ${message}`,
        );
        options.logger.error(
            checkWrote
                ? "rows may already be written by the check; check the shard before running the command again"
                : "no rows were written; re-run the same command once the worker is reachable",
        );
    }

    for (const shard of check.batcher.totals.failed) {
        options.logger.error(
            `import: shard "${shard.shardKey}" was never reached${shard.timedOut ? " (timed out)" : ""} — no rows were written: ${shard.message}`,
        );
    }

    // A worker that wrote during the check has already changed the shard, so the refusal must not say the file was not written.
    const written = Object.values(check.batcher.totals.inserted).reduce((sum, count) => sum + count, 0);
    const error = checkWrote
        ? `import: ${options.file} was refused, and rows may already be written: ${refusal}`
        : `import: ${options.file} was not written: ${refusal}`;

    return { body, code: 1, data: { file: options.file, inserted: written, summary: body }, error, inserted: written };
};

/**
 * Why a check refuses the file, or `undefined` when every row may be written. A check writes nothing, so a row it wrote, a conflict it met, a
 * shard it could not reach or a row it refused each means the file cannot be imported as it stands. A worker that writes during a check
 * ignored the dry-run flag, and the rows it wrote are already in place.
 */
const checkRefusal = (check: ImportPass): string | undefined => {
    if (check.streamFailure !== undefined) {
        return `the check stopped early: ${failureMessage(check.streamFailure)}`;
    }

    const { errors, failed } = check.batcher.totals;

    if (checkMetWrites(check)) {
        return "this worker wrote rows during its check, so it cannot check an import before writing, and some rows may already be written";
    }

    if (failed.length > 0) {
        return `${String(failed.length)} shard(s) could not be reached to check`;
    }

    const refused = errors.filter((error) => error.code !== GLOBAL_DRY_RUN_UNSUPPORTED);

    return refused.length > 0 ? `${String(refused.length)} row(s) would be refused` : undefined;
};

/** Each shard the fan-out never reached. Its rows are in neither `inserted` nor `errors`, so the run has to name them. */
const logUnreachedShards = (logger: Logger, shards: ImportShardFailure[]): void => {
    for (const shard of shards) {
        logger.error(
            `import: shard "${shard.shardKey}" was never reached${shard.timedOut ? " (timed out)" : ""} — its rows were NOT written: ${shard.message}`,
        );
    }
};

/**
 * Why the worker cannot check a file before writing it, or `undefined` when it can. A worker built before `?dryRun=true` existed ignores the
 * flag and writes every row it is sent, and the check would learn that only after the rows are in. So the probe sends no row, which no worker
 * version can write, and only a worker that honours the flag echoes `dryRun: true` in its answer.
 */
const probeDryRunSupport = async (target: ImportPassTarget): Promise<string | undefined> => {
    try {
        const response = await target.fetchImpl(`${target.requestUrl}?dryRun=true`, {
            // A blank line rather than an empty body: a request with no body is refused before any line is read.
            body: "\n",
            headers: { authorization: `Bearer ${target.token}`, "content-type": "application/x-ndjson" },
            method: "POST",
        });

        if (!response.ok) {
            return `the worker at ${target.requestUrl} answered HTTP ${String(response.status)} to the check`;
        }

        const json = (await response.json()) as { dryRun?: unknown };

        return json.dryRun === true
            ? undefined
            : `the worker at ${target.requestUrl} predates ?dryRun=true, so it would write the file while checking it; deploy the current runtime and import again`;
    } catch (error) {
        return `the worker at ${target.requestUrl} did not answer the check: ${failureMessage(error)}`;
    }
};

const runImportCommand = async (options: ImportCommandOptions): Promise<ImportCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    // Route the human/progress channel once, here: every helper below is handed
    // this same `options`, so in `--format json` mode their output goes to stderr
    // too and stdout carries only the summary document.
    const source = await resolveImportSource(options, cwd);

    if (source.kind === "invalid") {
        // `resolveImportSource` logged which source it could not read.
        return { body: undefined, code: EXIT_CODE.USAGE, error: `import: could not read ${options.file}`, inserted: 0 };
    }

    // Scan-only: it writes the candidate mapping and imports nothing, so it runs
    // before the worker/token preconditions — the operator inspects an export
    // long before a target worker exists.
    if (options.scan === true) {
        return scanOnly(source, cwd, options);
    }

    const request = await resolveImportRequest(options);

    if (isRefusal(request)) {
        // `resolveImportRequest` logged the reason; its code says which kind.
        return { body: undefined, code: request.refused, error: "import: could not resolve the worker URL and admin token", inserted: 0 };
    }

    const { baseUrl, fetchImpl, requestUrl, token } = request;
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;
    const target: ImportPassTarget = { batchSize, fetchImpl, requestUrl, token };

    // Before any row or blob is sent: a worker that cannot check must not see the file at all.
    const unsupported = await probeDryRunSupport(target);

    if (unsupported !== undefined) {
        return { body: undefined, code: 1, error: `import: ${options.file} was not written: ${unsupported}`, inserted: 0 };
    }

    // Phase 1: check the whole file, writing nothing, before any blob moves. A
    // refused file leaves neither a row nor a blob behind. The check runs quietly
    // and its errors come back in its own totals.
    const plan = await planStoragePhase(source, options, cwd);

    if (plan === undefined) {
        // `planStoragePhase` logged which requirement the export does not meet.
        return { body: undefined, code: 1, error: "import: the storage phase failed — no rows were written", inserted: 0 };
    }

    const check = await runImportPass(quietOptions(options), source, plan, { ...target, requestUrl: `${requestUrl}?dryRun=true` });
    const refusal = checkRefusal(check);

    if (refusal !== undefined) {
        // Nothing was uploaded, so the refusal reports no storage block.
        return refuseFile(options, check, refusal, undefined);
    }

    // Phase 2: move the files, so no imported document can reference an object
    // that is not there yet.
    const storage = await runStoragePhase({ baseUrl, fetchImpl, token }, source, options, cwd, plan);

    if (storage === undefined) {
        // `runStoragePhase` logged which object it could not move.
        return { body: undefined, code: 1, error: "import: the storage phase failed — no rows were written", inserted: 0 };
    }

    const { storageIdMap } = storage;

    options.logger.info(
        source.kind === "convex"
            ? `POST ${requestUrl} -> import Convex export ${options.file} (${String(source.tables.length)} tables)`
            : `POST ${requestUrl} -> import ${options.file}`,
    );

    const { batcher, remapReport, sourceRows, streamFailure, unresolvedPaths } = await runImportPass(options, source, storage, target);

    const { conflicts, errors, failed: failedShards, inserted, received, warnings } = batcher.totals;

    // Parity over an aborted run only restates the abort, so skip it there and
    // let the failure be the verdict.
    const parityMismatch = options.verify === true && streamFailure === undefined ? checkRowParity(options.logger, sourceRows, { conflicts, inserted }) : 0;
    const unmigratedFailure = storageIdMap !== undefined && reportStorageOutcome(options.logger, remapReport, options.verify === true);

    const unresolvedPathFailure = reportUntransferredPaths(options.logger, unresolvedPaths, options.verify === true);

    const insertedTotal = Object.values(inserted).reduce((a, b) => a + b, 0);
    const body = buildImportBody(batcher.totals, storageIdMap, remapReport);

    // A shard the fan-out never reached leaves an unknown slice of the import
    // unwritten, and its rows land in neither `inserted` nor `errors`. The
    // endpoint says so with 207 Multi-Status, whose `Response.ok` is `true` —
    // so without this the run reported a clean success over missing data.
    logUnreachedShards(options.logger, failedShards);

    const failed =
        streamFailure !== undefined || errors.length > 0 || failedShards.length > 0 || parityMismatch > 0 || unmigratedFailure || unresolvedPathFailure;

    // The batcher's roll-up, spelled out for a human. Pretty mode only: in json
    // the same object IS the document's `summary`, and printing it here too said
    // the whole thing twice per run.
    if (options.format !== "json") {
        options.logger.info(JSON.stringify(body, undefined, 2));
    }

    reportImportOutcome(options.logger, { conflicts, errorCount: errors.length, failed, insertedTotal, received, warnings });

    const data = { file: options.file, inserted: insertedTotal, summary: body };

    if (failed) {
        // The per-row detail is in `data.summary`; this is the one line that says
        // the run did not come out clean.
        return { body, code: 1, data, error: `import: ${options.file} did not import cleanly`, inserted: insertedTotal };
    }

    return { body, code: 0, data, inserted: insertedTotal };
};

export type { ImportCommandData, ImportCommandOptions, ImportCommandResult };
export { DEFAULT_IMPORT_BATCH_SIZE, runImportCommand };
