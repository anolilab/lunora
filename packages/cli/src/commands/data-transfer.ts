/**
 * `lunora export` / `lunora import` — Convex-style bulk data transfer.
 *
 * `export` streams NDJSON from the worker's `POST /_lunora/admin/export`
 * endpoint to stdout (or `--out` file). `import` reads an NDJSON file and
 * POSTs batches to `POST /_lunora/admin/import`, surfacing inserted/error
 * counts to the user.
 *
 * Authentication mirrors `vis migrate`: an admin bearer via `--token` or
 * `LUNORA_ADMIN_TOKEN`. `--prod` (with an explicit `--url`) is the guardrail
 * against accidentally targeting localhost in production scripts.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { LunoraError } from "@lunora/errors";

import { resolveAdminBearer } from "../util/admin-token";
import { resolveAdminBaseUrl } from "../util/admin-url";
import type { Logger } from "../util/logger";
import type { FetchLike } from "./run/handler";

const EXPORT_ENDPOINT_PATH = "/_lunora/admin/export";
const IMPORT_ENDPOINT_PATH = "/_lunora/admin/import";
const STORAGE_ENDPOINT_PATH = "/_lunora/admin/storage";
const STORAGE_URL_ENDPOINT_PATH = "/_lunora/admin/storage/url";

/** Rows per HTTP request when importing. Convex uses ~500; same here. */
const DEFAULT_IMPORT_BATCH_SIZE = 500;

/**
 * Minimal projection of `globalThis.fetch` for the export path — we need
 * `body` as a stream-iterable, which the shared {@link FetchLike} type
 * intentionally hides for the JSON-only commands.
 */
type StreamingFetchLike = (
    input: string,
    init?: { body?: string; headers?: Record<string, string>; method?: string },
) => Promise<{
    body: ReadableStream<Uint8Array> | null;
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;

interface ExportCommandOptions {
    cwd?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Output file path; `undefined`/`-` streams to stdout. */
    out?: string;
    /** Guardrail: refuse to target localhost when set. */
    prod?: boolean;
    /** Comma-separated table list; omit to export every table. */
    tables?: string;
    /** Admin bearer token (or `LUNORA_ADMIN_TOKEN`). */
    token?: string;
    /** Worker URL (default `http://localhost:8787`). */
    url?: string;
}

interface ExportCommandResult {
    bytes: number;
    code: number;
    /** Number of NDJSON lines streamed (0 on error). */
    rows: number;
}

const resolveTables = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    const tables = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return tables.length > 0 ? tables : undefined;
};

/**
 * Honour backpressure: if the sink can't keep up (slow filesystem, piped
 * stdout consumer), `sink.write` returns false — wait for `drain` before
 * resuming. Otherwise Node buffers writes in the heap and a 10M-row export
 * materialises in memory, defeating the streaming goal.
 */
const writeWithBackpressure = async (sink: NodeJS.WritableStream, line: string): Promise<void> => {
    if (!sink.write(line)) {
        await new Promise<void>((resolve) => {
            sink.once("drain", resolve);
        });
    }
};

/**
 * Drain the worker's NDJSON response into the sink, counting bytes and rows.
 * Pipes straight through so a 10M-row export never materialises in memory.
 */
const streamNdjsonToSink = async (body: ReadableStream<Uint8Array>, sink: NodeJS.WritableStream): Promise<{ bytes: number; rows: number }> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let rows = 0;
    let leftover = "";
    let done = false;

    try {
        while (!done) {
            // eslint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially
            const read = await reader.read();

            done = read.done;

            if (read.value === undefined) {
                continue;
            }

            bytes += read.value.length;
            leftover += decoder.decode(read.value, { stream: true });

            let newlineIndex = leftover.indexOf("\n");

            while (newlineIndex !== -1) {
                rows += 1;
                const line = `${leftover.slice(0, newlineIndex)}\n`;

                // eslint-disable-next-line no-await-in-loop -- backpressure is intentionally sequential
                await writeWithBackpressure(sink, line);
                leftover = leftover.slice(newlineIndex + 1);
                newlineIndex = leftover.indexOf("\n");
            }
        }

        if (leftover.length > 0) {
            rows += 1;
            await writeWithBackpressure(sink, `${leftover}\n`);
        }

        return { bytes, rows };
    } finally {
        // Release the body lock even on a thrown write/decode error so the
        // response stream isn't left locked.
        reader.releaseLock();
    }
};

/**
 * Close the write stream and remove the partial backup after a mid-stream
 * export failure. No-op for the stdout sink (`outPath === undefined`).
 */
const discardPartialExport = async (sink: NodeJS.WritableStream, outPath: string | undefined): Promise<void> => {
    if (outPath === undefined) {
        return;
    }

    (sink as ReturnType<typeof createWriteStream>).destroy();

    try {
        await unlink(outPath);
    } catch {
        /* ignore — partial file may not exist */
    }
};

/**
 * Stream an export. The worker emits NDJSON; we count newlines as we go and
 * pipe straight to the output sink, so a 10M-row export doesn't materialise
 * the body in memory.
 */
const runExportCommand = async (options: ExportCommandOptions): Promise<ExportCommandResult> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to export from the implicit localhost worker)");

        return { bytes: 0, code: 1, rows: 0 };
    }

    // Resolve the target FIRST: the `.dev.vars` fallback is gated on the request's
    // real destination, and with no `--url` that comes from the dev-server record,
    // not from the (undefined) flag.
    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return { bytes: 0, code: 1, rows: 0 };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return { bytes: 0, code: 1, rows: 0 };
    }

    const requestUrl = `${baseUrl}${EXPORT_ENDPOINT_PATH}`;
    const tables = resolveTables(options.tables);

    const fetchImpl = (options.fetchImpl ?? (globalThis as unknown as { fetch: StreamingFetchLike }).fetch) as StreamingFetchLike | undefined;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    options.logger.info(`POST ${requestUrl} -> export${tables ? ` (tables: ${tables.join(",")})` : ""}`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify(tables ? { tables } : {}),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const errorText = await response.text();

        options.logger.error(`export failed: HTTP ${String(response.status)}: ${errorText}`);

        return { bytes: 0, code: 1, rows: 0 };
    }

    if (!response.body) {
        options.logger.error("export response carried no body");

        return { bytes: 0, code: 1, rows: 0 };
    }

    // Open the output sink: stdout when `out` is `undefined` / `-`, otherwise
    // a file stream so a 10M-row dump never bloats Node's heap.
    const outPath = options.out === undefined || options.out === "-" ? undefined : options.out;
    const sink = outPath === undefined ? process.stdout : createWriteStream(outPath, { encoding: "utf8" });

    let bytes: number;
    let rows: number;

    try {
        ({ bytes, rows } = await streamNdjsonToSink(response.body, sink));
    } catch (error) {
        // On a mid-stream failure, close the file descriptor and remove the
        // partial backup so we don't leak the fd or leave a truncated dump.
        await discardPartialExport(sink, outPath);

        throw error;
    }

    if (outPath !== undefined) {
        await new Promise<void>((resolve, reject) => {
            (sink as ReturnType<typeof createWriteStream>).end((error?: Error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        options.logger.success(`wrote ${String(rows)} rows to ${outPath} (${String(bytes)} bytes)`);
    }

    return { bytes, code: 0, rows };
};

interface ImportCommandOptions {
    /** Rows per HTTP request. Defaults to {@link DEFAULT_IMPORT_BATCH_SIZE}. */
    batchSize?: number;
    cwd?: string;
    fetchImpl?: StreamingFetchLike;
    /** Source NDJSON file. Required. */
    file: string;
    logger: Logger;
    prod?: boolean;

    /**
     * Wrap each line as `{table:<name>,doc:<line>}`. Use when the source NDJSON
     * is bare docs from a single table — Convex's `convex import --table users`
     * shape.
     */
    table?: string;
    token?: string;
    url?: string;

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

    return { fetchImpl, requestUrl: `${baseUrl}${IMPORT_ENDPOINT_PATH}`, token };
};

/**
 * Convex's own file table. Its rows describe stored BLOBS, not application
 * data — the bytes sit next to the JSONL as separate files and belong in R2,
 * so importing the rows alone would create dangling references.
 */
const CONVEX_STORAGE_TABLE = "_storage";

/**
 * The `<table>/documents.jsonl` files in a `npx convex export --path <dir>`
 * directory, sorted for deterministic output.
 *
 * Returns `undefined` when `path` is not such a directory, which is how the
 * import command decides between the Convex layout and a plain NDJSON file.
 */
const convexExportTables = async (path: string): Promise<undefined | { file: string; table: string }[]> => {
    const info = await stat(path).catch(() => undefined);

    if (!info?.isDirectory()) {
        return undefined;
    }

    const found: { file: string; table: string }[] = [];

    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        const file = join(path, entry.name, "documents.jsonl");

        // eslint-disable-next-line no-await-in-loop -- one cheap stat per table directory; the set is small.
        const documents = await stat(file).catch(() => undefined);

        if (documents?.isFile()) {
            found.push({ file, table: entry.name });
        }
    }

    return found.length > 0 ? found.toSorted((a, b) => a.table.localeCompare(b.table)) : undefined;
};

/** Stream one `documents.jsonl` as `{ table, doc }` NDJSON lines. */
// eslint-disable-next-line func-style -- a generator cannot be written as an arrow function; `function*` is the only form.
async function* wrapJsonlLines(file: string, table: string): AsyncGenerator<string> {
    for await (const raw of createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(file, { encoding: "utf8" }) })) {
        const line = raw.trim();

        if (line.length > 0) {
            yield `${JSON.stringify({ doc: JSON.parse(line) as unknown, table })}\n`;
        }
    }
}

/**
 * Stream a Convex export directory as the `{ table, doc }` NDJSON the admin
 * import endpoint accepts.
 *
 * **No id remapping.** The reporter's migration assumed Convex `_id`s had to be
 * rewritten to freshly-minted Lunora ids, which forces a two-pass import
 * (insert with FKs nulled, then patch them back through an id map) to survive
 * self-referential cycles. That is unnecessary here: the admin import path
 * inserts with `allowExplicitId`, preserving `_id` verbatim, and `v.id()`
 * validates only that the value is a string. So every Convex id — including
 * every `v.id()` foreign key already pointing at one — carries across
 * unchanged, and a plain single-pass import is correct.
 */
// eslint-disable-next-line func-style -- a generator cannot be written as an arrow function; `function*` is the only form.
async function* readConvexExport(tables: ReadonlyArray<{ file: string; table: string }>, logger: Logger): AsyncGenerator<string> {
    for (const { file, table } of tables) {
        if (table === CONVEX_STORAGE_TABLE) {
            logger.warn(`skipping "${CONVEX_STORAGE_TABLE}" — those rows describe stored files. Upload the exported blobs to R2 and re-point the keys.`);

            continue;
        }

        yield* wrapJsonlLines(file, table);
    }
}

/**
 * Decide whether the positional path is a Convex export directory or a plain
 * NDJSON file, rejecting the shapes that cannot be either.
 */
const resolveImportSource = async (
    options: ImportCommandOptions,
): Promise<{ convexTables?: ReadonlyArray<{ file: string; table: string }>; error: boolean }> => {
    const convexTables = await convexExportTables(options.file);
    const stats = await stat(options.file);

    if (convexTables === undefined && stats.isDirectory()) {
        options.logger.error(
            `${options.file} is a directory but holds no <table>/documents.jsonl — expected a \`npx convex export --path <dir>\` dump, or pass an NDJSON file.`,
        );

        return { error: true };
    }

    if (convexTables && options.table !== undefined) {
        options.logger.error("--table cannot be combined with a Convex export directory — each row's table comes from its source directory.");

        return { error: true };
    }

    return { convexTables, error: false };
};

/**
 * Decide whether the positional path is a Convex export directory or a plain
 * NDJSON file, rejecting the shapes that cannot be either.
 */
const readStorageMetadata = async (
    exportDirectory: string,
    logger: Logger,
): Promise<{ _id: string; contentType?: string; sha256: string; size: number }[]> => {
    const metadataFile = join(exportDirectory, "_storage", "documents.jsonl");
    const rows: { _id: string; contentType?: string; sha256: string; size: number }[] = [];

    try {
        const stream = createReadStream(metadataFile, { encoding: "utf8" });
        const rl = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });

        for await (const raw of rl) {
            const line = raw.trim();

            if (line.length === 0) {
                continue;
            }

            const storageDocument = JSON.parse(line) as { _id: string; contentType?: string; sha256: string; size: number };

            rows.push({ _id: storageDocument._id, contentType: storageDocument.contentType, sha256: storageDocument.sha256, size: storageDocument.size });
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`failed to read _storage metadata: ${message}`);

        throw error;
    }

    return rows;
};

/**
 * Upload one Convex storage blob to the worker's verified admin route (small blobs)
 * or via a presigned PUT URL (large blobs). Returns the R2 key the blob was stored
 * under (`[keyPrefix]<sha256hex>`).
 */
const uploadSmallBlob = async (
    baseUrl: string,
    token: string,
    key: string,
    blobBytes: Buffer,
    metadata: { contentType?: string; sha256: string; size: number },
): Promise<string> => {
    const url = `${baseUrl}${STORAGE_ENDPOINT_PATH}?key=${encodeURIComponent(key)}&expectedSha256=${metadata.sha256}&expectedSize=${String(metadata.size)}`;

    const response = await fetch(url, {
        body: new Uint8Array(blobBytes),
        headers: { authorization: `Bearer ${token}`, "content-type": metadata.contentType ?? "application/octet-stream" },
        method: "PUT",
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "<no body>");

        throw new LunoraError("INTERNAL", `blob upload failed (HTTP ${String(response.status)}): ${text}`);
    }

    const json = (await response.json()) as { sha256?: string };

    if (json.sha256 !== metadata.sha256) {
        throw new LunoraError("INTERNAL", `blob upload verification failed: expected ${metadata.sha256}, got ${json.sha256 ?? "none"}`);
    }

    return key;
};

const uploadLargeBlob = async (
    baseUrl: string,
    token: string,
    key: string,
    blobBytes: Buffer,
    metadata: { contentType?: string; sha256: string; size: number },
): Promise<string> => {
    const urlUrl = `${baseUrl}${STORAGE_URL_ENDPOINT_PATH}?key=${encodeURIComponent(key)}&method=PUT&contentType=${encodeURIComponent(metadata.contentType ?? "application/octet-stream")}`;

    const urlResponse = await fetch(urlUrl, {
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
    });

    if (!urlResponse.ok) {
        const text = await urlResponse.text().catch(() => "<no body>");

        throw new LunoraError("INTERNAL", `failed to get signed PUT URL (HTTP ${String(urlResponse.status)}): ${text}`);
    }

    const { url: signedUrl } = (await urlResponse.json()) as { key: string; url: string };

    const putResponse = await fetch(signedUrl, {
        body: new Uint8Array(blobBytes),
        headers: { "content-type": metadata.contentType ?? "application/octet-stream" },
        method: "PUT",
    });

    if (!putResponse.ok) {
        const text = await putResponse.text().catch(() => "<no body>");

        throw new LunoraError("INTERNAL", `signed PUT failed (HTTP ${String(putResponse.status)}): ${text}`);
    }

    const listUrl = `${baseUrl}${STORAGE_ENDPOINT_PATH}?prefix=${encodeURIComponent(key)}`;

    const listResponse = await fetch(listUrl, {
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
    });

    if (!listResponse.ok) {
        const text = await listResponse.text().catch(() => "<no body>");

        throw new LunoraError("INTERNAL", `post-upload verification failed (HTTP ${String(listResponse.status)}): ${text}`);
    }

    const listJson = (await listResponse.json()) as { objects: { contentType?: string; key: string; sha256?: string; size?: number }[] };
    const stored = listJson.objects.find((object_) => object_.key === key);

    if (!stored) {
        throw new LunoraError("INTERNAL", `post-upload verification failed: blob not found at key ${key}`);
    }

    if (stored.sha256 !== metadata.sha256 || stored.size !== metadata.size) {
        throw new LunoraError(
            "INTERNAL",
            `post-upload verification failed: expected sha256=${metadata.sha256} size=${String(metadata.size)}, got sha256=${stored.sha256 ?? "none"} size=${String(stored.size ?? "none")}`,
        );
    }

    return key;
};

const uploadStorageBlob = async (
    baseUrl: string,
    token: string,
    blobPath: string,
    metadata: { contentType?: string; sha256: string; size: number },
    keyPrefix: string,
): Promise<string> => {
    const key = `${keyPrefix}${metadata.sha256}`;

    const blobBytes = await readFile(blobPath);

    const MAX_VERIFIED_UPLOAD_BYTES = 1_048_576;

    if (blobBytes.length <= MAX_VERIFIED_UPLOAD_BYTES) {
        return uploadSmallBlob(baseUrl, token, key, blobBytes, metadata);
    }

    return uploadLargeBlob(baseUrl, token, key, blobBytes, metadata);
};

/**
 * Migrate Convex `_storage` blobs: read `_storage/documents.jsonl`, upload each
 * blob with sha256+size verification, and build the `storageId → key` map.
 * Fail-close on any mismatch or missing file.
 */
const migrateStorageBlobs = async (
    baseUrl: string,
    adminToken: string,
    exportDirectory: string,
    logger: Logger,
): Promise<Map<string, string>> => {
    const metadataRows = await readStorageMetadata(exportDirectory, logger);
    const keyPrefix = ""; // TODO: read from lunora/import-convex.json (W3)
    const storageIdMap = new Map<string, string>();

    logger.info(`migrating ${String(metadataRows.length)} storage blobs...`);

    for (const row of metadataRows) {
        const blobPath = join(exportDirectory, "_storage", row._id);

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential upload: each blob must be verified before the next starts
            const key = await uploadStorageBlob(baseUrl, adminToken, blobPath, row, keyPrefix);

            storageIdMap.set(row._id, key);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            logger.error(`failed to upload blob ${row._id}: ${message}`);

            throw error;
        }
    }

    logger.success(`migrated ${String(metadataRows.length)} storage blobs`);

    return storageIdMap;
};

/**
 * Rewrite storage references in a document using the storageIdMap.
 * - `{ $storage: id }` objects are auto-rewritten to the content-hash key.
 * - Plain-string columns listed in the mapping are rewritten.
 * - Unmapped storage-id strings are reported (not rewritten).
 */
const remapStorageReferences = (
    document_: Record<string, unknown>,
    storageIdMap: Map<string, string>,
): Record<string, unknown> => {
    const remapped: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(document_)) {
        if (value && typeof value === "object" && !Array.isArray(value) && "$storage" in (value as Record<string, unknown>)) {
            // Auto-rewrite { $storage: id } objects.
            const storageId = (value as Record<string, unknown>).$storage as string;
            const mappedKey = storageIdMap.get(storageId);

            remapped[key] = mappedKey ?? value;
        } else if (typeof value === "string" && storageIdMap.has(value)) {
            // Plain string that matches a storage id — rewrite to the content-hash key.
            remapped[key] = storageIdMap.get(value) ?? value;
        } else {
            remapped[key] = value;
        }
    }

    return remapped;
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

/**
 * Stream an NDJSON file — or a `npx convex export --path <dir>` directory — in
 * chunks, POSTing each batch to `/_lunora/admin/import`. The line buffer stays
 * bounded by `batchSize`, so a multi-GiB source imports without buffering
 * everything in memory.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- the import command orchestrates several phases; extracted helpers keep each small
const runImportCommand = async (options: ImportCommandOptions): Promise<ImportCommandResult> => {
    const request = await resolveImportRequest(options);

    if (request === undefined) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const { fetchImpl, requestUrl, token } = request;
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;

    const source = await resolveImportSource(options);

    if (source.error) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const { convexTables } = source;

    // Phase 1 (W2): migrate Convex `_storage` blobs when `--with-storage` is set.
    let storageIdMap: Map<string, string> | undefined;

    if (options.withStorage && convexTables) {
        const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

        if (baseUrl === undefined) {
            return { body: undefined, code: 1, inserted: 0 };
        }

        const { token: adminToken } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

        if (!adminToken) {
            options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

            return { body: undefined, code: 1, inserted: 0 };
        }

        storageIdMap = await migrateStorageBlobs(baseUrl, adminToken, options.file, options.logger);

        options.logger.info(`storage map: ${String(storageIdMap.size)} blobs mapped`);
    }

    options.logger.info(
        convexTables
            ? `POST ${requestUrl} -> import Convex export ${options.file} (${String(convexTables.length)} tables)`
            : `POST ${requestUrl} -> import ${options.file}`,
    );

    // Read the source as text and split into lines, then chunk + POST. For very
    // large files we could swap this for createReadStream + line streaming —
    // batching makes the in-memory cost bounded per request either way. The
    // Convex reader is already a line-at-a-time generator and slots straight in,
    // since both are `for await`-able sources of text chunks.
    const stream = convexTables ? readConvexExport(convexTables, options.logger) : createReadStream(options.file, { encoding: "utf8" });
    const inserted: Record<string, number> = {};
    const errors: { code: string; line: number; message: string; table: string }[] = [];
    let conflicts = 0;
    let received = 0;
    const warnings: string[] = [];
    let buffer = "";
    let batch: string[] = [];
    let lineNumber = 0;

    /** Fold one admin-import response into the run's running totals. */
    const mergeImportResponse = (json: {
        conflicts?: number;
        errors?: { code: string; line: number; message: string; table: string }[];
        inserted?: Record<string, number>;
        received?: number;
        warnings?: string[];
    }): void => {
        for (const [table, count] of Object.entries(json.inserted ?? {})) {
            inserted[table] = (inserted[table] ?? 0) + count;
        }

        errors.push(...(json.errors ?? []));
        conflicts += json.conflicts ?? 0;
        received += json.received ?? 0;

        // The endpoint's own diagnostics — e.g. "no `resolveTableSharding` is
        // configured, so every row was routed to the default shard". Dropping
        // these would leave the operator with a success line over a silently
        // misplaced import, which is the failure they report.
        for (const warning of json.warnings ?? []) {
            if (!warnings.includes(warning)) {
                warnings.push(warning);
            }
        }
    };

    const flush = async (): Promise<void> => {
        if (batch.length === 0) {
            return;
        }

        const body = batch.join("\n");

        batch = [];

        const response = await fetchImpl(requestUrl, {
            body,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
            method: "POST",
        });

        // Surface non-2xx as a hard failure — without this the command
        // exited 0 with `inserted` unchanged when the server rejected a
        // batch (auth failure, 5xx, malformed bearer), silently dropping
        // rows. response.json() could also throw on a non-JSON error body.
        if (!response.ok) {
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `import batch failed (HTTP ${String(response.status)}): ${text}`);
        }

        const json = (await response.json()) as {
            conflicts?: number;
            errors?: { code: string; line: number; message: string; table: string }[];
            inserted?: Record<string, number>;
            received?: number;
            warnings?: string[];
        };

        mergeImportResponse(json);
    };

    const processLine = (line: string): void => {
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            return;
        }

        lineNumber += 1;

        if (options.table === undefined) {
            // W3: remap storage references in Convex export documents.
            if (storageIdMap && (trimmed.includes("_storage") || trimmed.includes("$storage"))) {
                try {
                    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

                    if (parsed.doc && typeof parsed.doc === "object" && !Array.isArray(parsed.doc)) {
                        const storageDocument = parsed.doc as Record<string, unknown>;

                        parsed.doc = remapStorageReferences(storageDocument, storageIdMap);
                        batch.push(JSON.stringify({ doc: parsed.doc, table: typeof parsed.table === "string" ? parsed.table : "" }));
                        return;
                    }
                } catch {
                    // Not valid JSON or not a Convex doc — pass through.
                }
            }

            batch.push(trimmed);

            return;
        }

        // `--table` wraps each bare doc — the source is `{...}\n{...}\n`,
        // not `{table,doc}` envelopes. Guard the parse so a malformed line
        // surfaces a row-scoped error instead of an unhandled rejection.
        let parsedDocument: unknown;

        try {
            parsedDocument = JSON.parse(trimmed);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            throw new LunoraError("INTERNAL", `invalid JSON on line ${String(lineNumber)}: ${message}`, { cause: error });
        }

        // W3: remap storage references in the document.
        if (storageIdMap && parsedDocument && typeof parsedDocument === "object" && !Array.isArray(parsedDocument)) {
            parsedDocument = remapStorageReferences(parsedDocument as Record<string, unknown>, storageIdMap);
        }

        batch.push(JSON.stringify({ doc: parsedDocument, table: options.table }));
    };

    // `for await ... of` natively awaits each chunk + propagates errors
    // through the surrounding async function, so a thrown `processLine`/
    // `flush` rejects the outer promise instead of becoming an unhandled
    // rejection. Backpressure falls out of `await` — the loop only requests
    // the next chunk when the current one is drained.
    for await (const chunk of stream) {
        const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

        buffer += text;

        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex !== -1) {
            processLine(buffer.slice(0, newlineIndex));
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");

            if (batch.length >= batchSize) {
                // eslint-disable-next-line no-await-in-loop -- one POST per filled batch is the point
                await flush();
            }
        }
    }

    if (buffer.length > 0) {
        processLine(buffer);
    }

    await flush();

    const insertedTotal = Object.values(inserted).reduce((a, b) => a + b, 0);
    const body = { conflicts, errors, inserted, received, ...(warnings.length > 0 ? { warnings } : {}) };

    options.logger.info(JSON.stringify(body, undefined, 2));
    reportImportOutcome(options.logger, { conflicts, errorCount: errors.length, insertedTotal, received, warnings });

    return { body, code: errors.length > 0 ? 1 : 0, inserted: insertedTotal };
};

export type { ExportCommandOptions, ExportCommandResult, ImportCommandOptions, ImportCommandResult, StreamingFetchLike };
export { DEFAULT_IMPORT_BATCH_SIZE, runExportCommand, runImportCommand };
