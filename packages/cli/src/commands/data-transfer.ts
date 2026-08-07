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
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

import { resolveAdminBearer } from "../util/admin-token";
import { resolveAdminBaseUrl } from "../util/admin-url";
import type { Logger } from "../util/logger";
import type { ConvexSnapshot, ConvexSnapshotTable } from "./convex-snapshot";
import { listConvexSnapshotTables, readSnapshotLines, readSnapshotStorageBlob, readSnapshotText, resolveConvexSnapshot } from "./convex-snapshot";
import type { FetchLike } from "./run/handler";

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

const EXPORT_ENDPOINT_PATH = "/_lunora/admin/export";
const IMPORT_ENDPOINT_PATH = "/_lunora/admin/import";
const STORAGE_ENDPOINT_PATH = "/_lunora/admin/storage";
const STORAGE_URL_ENDPOINT_PATH = "/_lunora/admin/storage/url";

/** Rows per HTTP request when importing. Convex uses ~500; same here. */
const DEFAULT_IMPORT_BATCH_SIZE = 500;

/** How many dangling storage references to name individually before summarising. */
const DANGLING_REPORT_LIMIT = 20;

/**
 * Minimal projection of `globalThis.fetch` for the export path — we need
 * `body` as a stream-iterable, which the shared {@link FetchLike} type
 * intentionally hides for the JSON-only commands.
 */
type StreamingFetchLike = (
    input: string,
    init?: { body?: string | Uint8Array; headers?: Record<string, string>; method?: string },
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
     * Scan the export for columns holding `_storage` ids and write a candidate
     * `lunora/import-convex.json`. Scan-only: nothing is imported.
     */
    scan?: boolean;

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

/** Stream one `documents.jsonl` as `{ table, doc }` NDJSON lines. */
// eslint-disable-next-line func-style -- a generator cannot be written as an arrow function; `function*` is the only form.
async function* wrapJsonlLines(snapshot: ConvexSnapshot, tableEntry: ConvexSnapshotTable): AsyncGenerator<string> {
    for await (const raw of readSnapshotLines(snapshot, tableEntry)) {
        const line = raw.trim();

        if (line.length > 0) {
            yield `${JSON.stringify({ doc: JSON.parse(line) as unknown, table: tableEntry.table })}\n`;
        }
    }
}

/**
 * Stream a Convex export snapshot as the `{ table, doc }` NDJSON the admin
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
async function* readConvexExport(snapshot: ConvexSnapshot, tables: ReadonlyArray<ConvexSnapshotTable>, logger: Logger): AsyncGenerator<string> {
    for (const tableEntry of tables) {
        if (tableEntry.table === CONVEX_STORAGE_TABLE) {
            logger.warn(`skipping "${CONVEX_STORAGE_TABLE}" — those rows describe stored files. Upload the exported blobs to R2 and re-point the keys.`);

            continue;
        }

        yield* wrapJsonlLines(snapshot, tableEntry);
    }
}

/**
 * Decide whether the positional path is a Convex export snapshot (directory or
 * `.zip`) or a plain NDJSON file, rejecting the shapes that cannot be either.
 */
const resolveImportSource = async (
    options: ImportCommandOptions,
): Promise<{ convexSnapshot?: ConvexSnapshot; convexTables?: ReadonlyArray<ConvexSnapshotTable>; error: boolean }> => {
    const snapshot = await resolveConvexSnapshot(options.file);
    const convexTables = snapshot === undefined ? undefined : await listConvexSnapshotTables(snapshot);

    if (convexTables === undefined && snapshot?.kind === "directory") {
        options.logger.error(
            `${options.file} is a directory but holds no <table>/documents.jsonl — expected a \`npx convex export --path <dir>\` dump, or pass an NDJSON file.`,
        );

        return { error: true };
    }

    if (convexTables === undefined && snapshot?.kind === "zip") {
        options.logger.error(
            `${options.file} is a .zip but holds no <table>/documents.jsonl — expected a \`npx convex export --path <snapshot.zip>\` snapshot, or pass an NDJSON file.`,
        );

        return { error: true };
    }

    if (convexTables && options.table !== undefined) {
        options.logger.error("--table cannot be combined with a Convex export directory — each row's table comes from its source directory.");

        return { error: true };
    }

    return { convexSnapshot: snapshot, convexTables, error: false };
};

/** One validated `_storage/documents.jsonl` row: the blob's id, digest, and byte length. */
interface StorageMetadataRow {
    contentType?: string;
    id: string;
    /** Lowercase hex, whatever encoding the export used. */
    sha256: string;
    size: number;
}

const HEX_SHA256_RE = /^[\dA-F]{64}$/i;
const BASE64_SHA256_RE = /^[\d+/A-Z]{43}=$/i;

/**
 * Normalise the export's `sha256` to lowercase hex.
 *
 * Convex has emitted this field both as base16 and as base64 across versions,
 * and the value is used three ways — as the R2 key, as the `expectedSha256`
 * query parameter, and as the comparand for the digest the worker echoes back
 * (always lowercase hex). Normalising once at the boundary is what keeps an
 * uppercase or base64 source hash from becoming a false verification failure
 * plus a case-split key namespace.
 */
const normalizeSha256 = (raw: string): string | undefined => {
    if (HEX_SHA256_RE.test(raw)) {
        return raw.toLowerCase();
    }

    return BASE64_SHA256_RE.test(raw) ? Buffer.from(raw, "base64").toString("hex") : undefined;
};

/**
 * Validate one `_storage` metadata row, or throw naming the offending field. An
 * unusable row is never skipped: these values decide what bytes get written
 * under what key, so guessing is never the right answer.
 */
const parseStorageMetadataRow = (line: string, where: string): StorageMetadataRow => {
    const storageDocument = JSON.parse(line) as { _id?: unknown; contentType?: unknown; sha256?: unknown; size?: unknown };
    const id = storageDocument._id;

    if (typeof id !== "string" || id.length === 0 || id.includes("/") || id.includes("\\")) {
        throw new LunoraError("INTERNAL", `${where}: \`_id\` must be a path-free non-empty string`);
    }

    if (typeof storageDocument.sha256 !== "string") {
        throw new LunoraError("INTERNAL", `${where}: \`sha256\` is missing — re-export with \`npx convex export --include-file-storage\``);
    }

    const sha256 = normalizeSha256(storageDocument.sha256);

    if (sha256 === undefined) {
        throw new LunoraError("INTERNAL", `${where}: \`sha256\` is neither base16 nor base64 SHA-256 (${storageDocument.sha256})`);
    }

    if (typeof storageDocument.size !== "number" || !Number.isInteger(storageDocument.size) || storageDocument.size < 0) {
        throw new LunoraError("INTERNAL", `${where}: \`size\` must be a non-negative integer`);
    }

    return {
        contentType: typeof storageDocument.contentType === "string" ? storageDocument.contentType : undefined,
        id,
        sha256,
        size: storageDocument.size,
    };
};

/**
 * Read and validate `_storage/documents.jsonl` — the metadata rows describing
 * every exported blob.
 */
const readStorageMetadata = async (snapshot: ConvexSnapshot, storageTableEntry: ConvexSnapshotTable, logger: Logger): Promise<StorageMetadataRow[]> => {
    const rows: StorageMetadataRow[] = [];

    try {
        const text = await readSnapshotText(snapshot, storageTableEntry);

        for (const [index, line] of text.split("\n").entries()) {
            const trimmed = line.trim();

            if (trimmed.length > 0) {
                rows.push(parseStorageMetadataRow(trimmed, `_storage/documents.jsonl line ${String(index + 1)}`));
            }
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`failed to read _storage metadata: ${message}`);

        throw error;
    }

    return rows;
};

/**
 * Body budget of `PUT /_lunora/admin/storage` (mirrors the runtime's
 * `STORAGE_UPLOAD_MAX_BODY_BYTES`). Blobs up to this size take the verified
 * route, which digests the body and refuses to write on a mismatch; above it the
 * body cannot reach the worker at all, so the signed-PUT fallback applies.
 */
const MAX_VERIFIED_UPLOAD_BYTES = 32 * 1_048_576;

/** One object as `GET /_lunora/admin/storage` reports it. */
interface StorageListObject {
    key: string;
    sha256?: string;
    size?: number;
}

interface BlobUploadContext {
    baseUrl: string;
    fetchImpl: StreamingFetchLike;
    token: string;
}

/** List the objects under `prefix`, following the cursor to the end. */
const listStorageObjects = async (context: BlobUploadContext, prefix: string): Promise<StorageListObject[]> => {
    const objects: StorageListObject[] = [];
    let cursor: string | undefined;

    do {
        const url = `${context.baseUrl}${STORAGE_ENDPOINT_PATH}?prefix=${encodeURIComponent(prefix)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;

        // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential by definition
        const response = await context.fetchImpl(url, { headers: { authorization: `Bearer ${context.token}` }, method: "GET" });

        if (!response.ok) {
            // eslint-disable-next-line no-await-in-loop -- error body of the failed page
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `storage list failed (HTTP ${String(response.status)}): ${text}`);
        }

        // eslint-disable-next-line no-await-in-loop -- one page at a time
        const json = (await response.json()) as { cursor?: string; objects?: StorageListObject[]; truncated?: boolean };

        objects.push(...(json.objects ?? []));
        cursor = json.truncated === true ? json.cursor : undefined;
    } while (cursor !== undefined);

    return objects;
};

/**
 * Upload one blob through the checksum-verified admin route. The worker digests
 * the body and returns the computed hash, so a corrupt transfer is rejected
 * before anything is written.
 */
const uploadSmallBlob = async (context: BlobUploadContext, key: string, blobBytes: Buffer, metadata: StorageMetadataRow): Promise<string> => {
    const url = `${context.baseUrl}${STORAGE_ENDPOINT_PATH}?key=${encodeURIComponent(key)}&expectedSha256=${metadata.sha256}&expectedSize=${String(metadata.size)}`;

    const response = await context.fetchImpl(url, {
        body: new Uint8Array(blobBytes),
        headers: { authorization: `Bearer ${context.token}`, "content-type": metadata.contentType ?? "application/octet-stream" },
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

/** Best-effort removal of an object that failed post-upload verification. */
const deleteStorageObject = async (context: BlobUploadContext, key: string): Promise<void> => {
    await context
        .fetchImpl(`${context.baseUrl}${STORAGE_ENDPOINT_PATH}?key=${encodeURIComponent(key)}`, {
            headers: { authorization: `Bearer ${context.token}` },
            method: "DELETE",
        })
        .catch(() => undefined);
};

/**
 * Upload a blob too large for the worker's body cap through a signed `PUT` URL,
 * then verify what landed by listing it back.
 *
 * The bytes bypass the worker, so the pre-write digest check is not available
 * here. R2 only records a SHA-256 checksum when the writer supplied one, so the
 * list may legitimately omit `sha256`; size is always comparable. When the
 * object that landed does not match, it is DELETED before the failure
 * propagates — otherwise the bad object would sit at a content-hash key and a
 * later re-run would treat it as already-migrated.
 */
const uploadLargeBlob = async (context: BlobUploadContext, key: string, blobBytes: Buffer, metadata: StorageMetadataRow, logger: Logger): Promise<string> => {
    const mintUrl = `${context.baseUrl}${STORAGE_URL_ENDPOINT_PATH}?key=${encodeURIComponent(key)}&method=PUT&contentType=${encodeURIComponent(metadata.contentType ?? "application/octet-stream")}`;

    const urlResponse = await context.fetchImpl(mintUrl, { headers: { authorization: `Bearer ${context.token}` }, method: "GET" });

    if (!urlResponse.ok) {
        const text = await urlResponse.text().catch(() => "<no body>");

        throw new LunoraError(
            "INTERNAL",
            `blob ${key} is ${String(metadata.size)} bytes, above the ${String(MAX_VERIFIED_UPLOAD_BYTES)}-byte verified-upload cap, and no signed PUT URL could be minted (HTTP ${String(urlResponse.status)}): ${text}`,
        );
    }

    const { url: signedUrl } = (await urlResponse.json()) as { key: string; url: string };

    const putResponse = await context.fetchImpl(signedUrl, {
        body: new Uint8Array(blobBytes),
        headers: { "content-type": metadata.contentType ?? "application/octet-stream" },
        method: "PUT",
    });

    if (!putResponse.ok) {
        const text = await putResponse.text().catch(() => "<no body>");

        throw new LunoraError("INTERNAL", `signed PUT failed (HTTP ${String(putResponse.status)}): ${text}`);
    }

    const listed = await listStorageObjects(context, key);
    const stored = listed.find((object_) => object_.key === key);

    if (stored === undefined) {
        throw new LunoraError("INTERNAL", `post-upload verification failed: blob not found at key ${key}`);
    }

    const sizeMismatch = stored.size !== metadata.size;
    const hashMismatch = stored.sha256 !== undefined && stored.sha256.toLowerCase() !== metadata.sha256;

    if (sizeMismatch || hashMismatch) {
        await deleteStorageObject(context, key);

        throw new LunoraError(
            "INTERNAL",
            `post-upload verification failed: expected sha256=${metadata.sha256} size=${String(metadata.size)}, got sha256=${stored.sha256 ?? "none"} size=${String(stored.size ?? "none")} (the object was removed)`,
        );
    }

    if (stored.sha256 === undefined) {
        logger.warn(`blob ${key} exceeded the verified-upload cap and the host does not report a stored sha256 — verified by size only`);
    }

    return key;
};

const uploadStorageBlob = async (
    context: BlobUploadContext,
    blobBytes: Buffer,
    metadata: StorageMetadataRow,
    keyPrefix: string,
    logger: Logger,
): Promise<string> => {
    const key = `${keyPrefix}${metadata.sha256}`;

    // Catch a truncated source before any network call: the export's own
    // metadata is the only statement of what the blob should weigh.
    if (blobBytes.length !== metadata.size) {
        throw new LunoraError("INTERNAL", `blob ${metadata.id} is ${String(blobBytes.length)} bytes on disk but the export declares ${String(metadata.size)}`);
    }

    if (blobBytes.length <= MAX_VERIFIED_UPLOAD_BYTES) {
        return uploadSmallBlob(context, key, blobBytes, metadata);
    }

    return uploadLargeBlob(context, key, blobBytes, metadata, logger);
};

/**
 * Migrate Convex `_storage` blobs: read `_storage/documents.jsonl`, upload each
 * blob with sha256+size verification, and build the `storageId → key` map.
 * Fail-close on any mismatch or missing file.
 *
 * Re-runs are cheap and safe: keys are content hashes, so one prefix listing up
 * front tells us which blobs are already present at the right size, and those
 * are mapped without re-uploading.
 */
const migrateStorageBlobs = async (
    context: BlobUploadContext,
    snapshot: ConvexSnapshot,
    storageTableEntry: ConvexSnapshotTable,
    keyPrefix: string,
    logger: Logger,
): Promise<Map<string, string>> => {
    const metadataRows = await readStorageMetadata(snapshot, storageTableEntry, logger);
    const storageIdMap = new Map<string, string>();
    const alreadyStored = await listStorageObjects(context, keyPrefix);
    const existing = new Map(alreadyStored.map((object_) => [object_.key, object_]));
    let skipped = 0;

    logger.info(`migrating ${String(metadataRows.length)} storage blobs...`);

    for (const row of metadataRows) {
        const key = `${keyPrefix}${row.sha256}`;
        const present = existing.get(key);

        if (present?.size === row.size) {
            storageIdMap.set(row.id, key);
            skipped += 1;

            continue;
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: each blob is read + verified before the next starts
            const blobBytes = await readSnapshotStorageBlob(snapshot, storageTableEntry, row.id);

            // eslint-disable-next-line no-await-in-loop -- sequential upload: each blob must be verified before the next starts
            storageIdMap.set(row.id, await uploadStorageBlob(context, blobBytes, row, keyPrefix, logger));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            logger.error(`failed to upload blob ${row.id}: ${message}`);

            throw error;
        }
    }

    logger.success(`migrated ${String(metadataRows.length - skipped)} storage blobs${skipped > 0 ? ` (${String(skipped)} already present)` : ""}`);

    return storageIdMap;
};

/** What a document's storage references resolved to, accumulated across the run. */
interface StorageRemapReport {
    /** Storage ids referenced by a document but absent from the migrated map. */
    dangling: Map<string, string>;
    /** Number of references rewritten to a content-hash key. */
    rewritten: number;
}

/**
 * Rewrite storage references in one document against the `storageId → key` map,
 * returning the rewritten document plus what the walk found.
 *
 * `{ $storage: id }` objects are Convex's self-describing Storage value. They are
 * unambiguous, so they are rewritten wherever they occur, at any depth. A plain
 * string is ambiguous against ordinary text, so it is rewritten only where
 * `lunora/import-convex.json` names its column — or, with no mapping file at all,
 * wherever it exactly matches a migrated storage id. Anything that looks like a
 * storage reference but has no migrated blob is recorded as dangling and left
 * untouched; it is never guessed.
 *
 * The walk is recursive because Convex documents nest freely: a storage id in an
 * array of attachments or inside a nested object is exactly as load-bearing as a
 * top-level one, and skipping it leaves a reference that resolves to nothing
 * while the import still reports success.
 */
const remapStorageReferences = (
    document_: Record<string, unknown>,
    storageIdMap: Map<string, string>,
    table: string,
    storageColumns?: Record<string, string[]>,
): StorageRemapReport & { document: Record<string, unknown> } => {
    const dangling = new Map<string, string>();
    let rewritten = 0;

    /** `undefined` column = nested position, where only `{ $storage }` is unambiguous. */
    const isMappedColumn = (column: string | undefined): boolean =>
        column !== undefined && (storageColumns === undefined || storageColumns[table]?.includes(column) === true);

    const remapValue = (value: unknown, column: string | undefined): unknown => {
        if (Array.isArray(value)) {
            return value.map((entry) => remapValue(entry, column));
        }

        if (value !== null && typeof value === "object") {
            const record = value as Record<string, unknown>;

            if (typeof record["$storage"] === "string") {
                const storageId = record["$storage"];
                const mappedKey = storageIdMap.get(storageId);

                if (mappedKey === undefined) {
                    dangling.set(storageId, table);

                    return value;
                }

                rewritten += 1;

                return mappedKey;
            }

            // Nested objects lose the column context: `storageColumns` addresses
            // top-level columns, so a plain string deeper than that is ambiguous
            // and gets reported rather than rewritten.
            return Object.fromEntries(Object.entries(record).map(([nested, entry]) => [nested, remapValue(entry, undefined)]));
        }

        if (typeof value === "string" && storageIdMap.has(value)) {
            if (!isMappedColumn(column)) {
                dangling.set(value, table);

                return value;
            }

            rewritten += 1;

            return storageIdMap.get(value) ?? value;
        }

        return value;
    };

    const document = Object.fromEntries(Object.entries(document_).map(([column, value]) => [column, remapValue(value, column)]));

    return { dangling, document, rewritten };
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
 * Scan a Convex export for plain-string columns whose values exactly match a
 * `_storage` id, and write the candidate `lunora/import-convex.json` the import
 * consumes.
 *
 * Exact-matching is a *candidate* detector, not an authority: a column of user
 * text could in principle contain a storage id, so the operator confirms the
 * file before the import rewrites anything. An existing mapping file is never
 * overwritten — the candidate is printed instead.
 */
/* eslint-disable sonarjs/cognitive-complexity -- the scan walks every table and every row; the branches are the scan */
const scanStorageColumns = async (
    snapshot: ConvexSnapshot,
    convexTables: ReadonlyArray<ConvexSnapshotTable>,
    cwd: string,
    logger: Logger,
): Promise<ImportConvexMapping | undefined> => {
    const storageColumns: Record<string, string[]> = {};
    const storageTable = convexTables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

    if (storageTable === undefined) {
        logger.error("no `_storage` table in this export — re-export with `npx convex export --include-file-storage`");

        return undefined;
    }

    const metadataRows = await readStorageMetadata(snapshot, storageTable, logger);
    const storageIds = new Set(metadataRows.map((row) => row.id));

    logger.info(`found ${String(storageIds.size)} storage ids`);

    for (const tableEntry of convexTables) {
        if (tableEntry.table === CONVEX_STORAGE_TABLE) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential scan: each table stream is drained before the next
        for await (const raw of readSnapshotLines(snapshot, tableEntry)) {
            const line = raw.trim();

            if (line.length === 0) {
                continue;
            }

            let row: Record<string, unknown>;

            try {
                row = JSON.parse(line) as Record<string, unknown>;
            } catch (error: unknown) {
                throw new LunoraError(
                    "INTERNAL",
                    `${tableEntry.table}/documents.jsonl: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
                    {
                        cause: error,
                    },
                );
            }

            const { table } = tableEntry;

            for (const [column, value] of Object.entries(row)) {
                const matches =
                    typeof value === "string"
                        ? storageIds.has(value)
                        : Array.isArray(value) && value.some((entry) => typeof entry === "string" && storageIds.has(entry));

                if (matches) {
                    storageColumns[table] ??= [];

                    if (!storageColumns[table].includes(column)) {
                        storageColumns[table].push(column);
                    }
                }
            }
        }
    }

    const mapping: ImportConvexMapping = { keyPrefix: "", storageColumns };
    const mappingPath = join(cwd, IMPORT_CONVEX_MAPPING_FILE);
    const serialized = `${JSON.stringify(mapping, undefined, 4)}\n`;

    await mkdir(join(cwd, "lunora"), { recursive: true });

    try {
        // `wx` so a confirmed mapping is never clobbered by a re-scan.
        await writeFile(mappingPath, serialized, { encoding: "utf8", flag: "wx" });
        logger.success(`wrote candidate mapping to ${mappingPath} — review it, then re-run without --scan`);
    } catch (error: unknown) {
        if ((error as { code?: string }).code !== "EEXIST") {
            throw error;
        }

        logger.warn(`${mappingPath} already exists — leaving it untouched. Candidate mapping:`);
        logger.info(serialized);
    }

    return mapping;
};
/* eslint-enable sonarjs/cognitive-complexity */

/**
 * Count non-blank source lines per table in a Convex export directory.
 * `_storage` is excluded (its rows describe blobs, not application data).
 * Returns a map from table → row count, or undefined when the directory is not
 * a Convex export layout.
 */
const countConvexSourceRows = async (
    snapshot: ConvexSnapshot,
    convexTables: ReadonlyArray<ConvexSnapshotTable>,
    logger: Logger,
): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};

    for (const tableEntry of convexTables) {
        if (tableEntry.table === CONVEX_STORAGE_TABLE) {
            continue;
        }

        let count = 0;

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: one source table read before the next
            for await (const raw of readSnapshotLines(snapshot, tableEntry)) {
                if (raw.trim().length > 0) {
                    count += 1;
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            // A source table we cannot count is a source table we cannot verify;
            // reporting 0 here would let `--verify` pass on an unread table.
            logger.error(`failed to count ${tableEntry.table} source rows: ${message}`);

            throw error;
        }

        counts[tableEntry.table] = count;
    }

    return counts;
};

/**
 * Stream an NDJSON file — or a `npx convex export --path <dir>` directory — in
 * chunks, POSTing each batch to `/_lunora/admin/import`. The line buffer stays
 * bounded by `batchSize`, so a multi-GiB source imports without buffering
 * everything in memory.
 */
/* eslint-disable sonarjs/cognitive-complexity -- the import command orchestrates several phases; extracted helpers keep each small */
const runImportCommand = async (options: ImportCommandOptions): Promise<ImportCommandResult> => {
    const source = await resolveImportSource(options);

    if (source.error) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const { convexSnapshot, convexTables } = source;
    const cwd = options.cwd ?? process.cwd();

    // Every storage-aware flag needs the export's `_storage` sidecar. A plain
    // NDJSON source cannot supply one, and silently ignoring the flag is how an
    // operator ends up believing blobs migrated when none did.
    if (convexSnapshot === undefined || convexTables === undefined) {
        for (const [flag, enabled] of [
            ["--scan", options.scan],
            ["--verify", options.verify],
            ["--with-storage", options.withStorage],
        ] as const) {
            if (enabled === true) {
                options.logger.error(`${flag} requires a Convex export directory or .zip snapshot — ${options.file} is not one.`);

                return { body: undefined, code: 1, inserted: 0 };
            }
        }
    }

    // W3: scan for storage columns and write the candidate mapping. Scan-only —
    // it never imports, so it runs before the worker/token preconditions: the
    // operator inspects an export long before a target exists.
    if (options.scan === true && convexTables && convexSnapshot) {
        const scanned = await scanStorageColumns(convexSnapshot, convexTables, cwd, options.logger);

        return { body: scanned, code: scanned === undefined ? 1 : 0, inserted: 0 };
    }

    const request = await resolveImportRequest(options);

    if (request === undefined) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const { baseUrl, fetchImpl, requestUrl, token } = request;
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;

    // Phase 1 (W2): migrate Convex `_storage` blobs when `--with-storage` is set.
    let storageIdMap: Map<string, string> | undefined;
    let mapping: ImportConvexMapping | undefined;

    if (options.withStorage === true && convexTables && convexSnapshot) {
        mapping = await readImportConvexMapping(cwd, options.logger);

        const storageTableEntry = convexTables.find((entry) => entry.table === CONVEX_STORAGE_TABLE);

        if (storageTableEntry === undefined) {
            options.logger.error(
                "--with-storage requires a Convex export with a `_storage` metadata table — re-export with `npx convex export --include-file-storage`.",
            );

            return { body: undefined, code: 1, inserted: 0 };
        }

        storageIdMap = await migrateStorageBlobs({ baseUrl, fetchImpl, token }, convexSnapshot, storageTableEntry, mapping?.keyPrefix ?? "", options.logger);

        options.logger.info(`storage map: ${String(storageIdMap.size)} blobs mapped`);
    }

    const storageColumns = mapping?.storageColumns;
    const remapReport: StorageRemapReport = { dangling: new Map<string, string>(), rewritten: 0 };

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
    // W4: count source rows per table up front when verifying parity.
    const sourceRows = options.verify && convexSnapshot && convexTables ? await countConvexSourceRows(convexSnapshot, convexTables, options.logger) : undefined;

    const stream =
        convexSnapshot && convexTables ? readConvexExport(convexSnapshot, convexTables, options.logger) : createReadStream(options.file, { encoding: "utf8" });
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
            // W3: remap storage references in Convex export documents. Every
            // envelope is parsed — a storage id can sit in a plain column, which
            // no substring of the line announces.
            if (storageIdMap !== undefined) {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;

                if (typeof parsed["table"] !== "string") {
                    throw new LunoraError("INTERNAL", `line ${String(lineNumber)}: import envelope is missing a string \`table\``);
                }

                if (parsed["doc"] !== null && typeof parsed["doc"] === "object" && !Array.isArray(parsed["doc"])) {
                    // Rebuild from the parsed envelope so any field beyond
                    // `{ table, doc }` survives the rewrite.
                    const remap = remapStorageReferences(parsed["doc"] as Record<string, unknown>, storageIdMap, parsed["table"], storageColumns);

                    parsed["doc"] = remap.document;
                    remapReport.rewritten += remap.rewritten;

                    for (const [storageId, sourceTable] of remap.dangling) {
                        remapReport.dangling.set(storageId, sourceTable);
                    }
                }

                batch.push(JSON.stringify(parsed));

                return;
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

        // No storage remap on this path: `--table` is rejected alongside a Convex
        // export (`resolveImportSource`), and the map only exists for one.
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

    // W4: per-table parity check against the source line counts. A table whose
    // inserted total differs from its source row count is a silent miss — surface
    // it and exit non-zero.
    let parityMismatch = 0;

    if (sourceRows) {
        for (const [table, sourceCount] of Object.entries(sourceRows)) {
            const insertedCount = inserted[table];

            if (insertedCount !== sourceCount) {
                parityMismatch += 1;
                options.logger.error(
                    `verify: ${table} inserted ${String(insertedCount ?? 0)} of ${String(sourceCount)} source rows (${String(sourceCount - (insertedCount ?? 0))} missing)`,
                );
            }
        }

        if (parityMismatch > 0) {
            options.logger.error(`verify: ${String(parityMismatch)} table(s) failed row parity`);
        } else {
            options.logger.success("verify: all tables at row parity");
        }
    }

    // W4: dangling-storage report. A reference the migration could not resolve is
    // listed with the table it came from; under `--verify` it also fails the run,
    // because a "successful" import full of unresolvable file references is the
    // exact outcome the blob migration exists to prevent.
    if (storageIdMap !== undefined) {
        options.logger.info(`storage refs: ${String(remapReport.rewritten)} rewritten, ${String(remapReport.dangling.size)} unresolved`);

        for (const [storageId, table] of [...remapReport.dangling].slice(0, DANGLING_REPORT_LIMIT)) {
            options.logger.warn(
                `dangling storage reference in ${table}: ${storageId} (add its column to ${IMPORT_CONVEX_MAPPING_FILE}, or re-export with the blob)`,
            );
        }

        if (remapReport.dangling.size > DANGLING_REPORT_LIMIT) {
            options.logger.warn(`… and ${String(remapReport.dangling.size - DANGLING_REPORT_LIMIT)} more dangling storage references`);
        }

        if (options.verify === true && remapReport.dangling.size > 0) {
            options.logger.error(`verify: ${String(remapReport.dangling.size)} storage reference(s) resolved to no migrated blob`);
        }
    }

    const danglingFailure = options.verify === true && remapReport.dangling.size > 0;

    const insertedTotal = Object.values(inserted).reduce((a, b) => a + b, 0);
    const body = {
        conflicts,
        errors,
        inserted,
        received,
        ...(storageIdMap === undefined
            ? {}
            : { storage: { blobs: storageIdMap.size, dangling: [...remapReport.dangling.keys()], rewritten: remapReport.rewritten } }),
        ...(warnings.length > 0 ? { warnings } : {}),
    };

    options.logger.info(JSON.stringify(body, undefined, 2));
    reportImportOutcome(options.logger, { conflicts, errorCount: errors.length, insertedTotal, received, warnings });

    return { body, code: errors.length > 0 || parityMismatch > 0 || danglingFailure ? 1 : 0, inserted: insertedTotal };
};
/* eslint-enable sonarjs/cognitive-complexity */

export type { ExportCommandOptions, ExportCommandResult, ImportCommandOptions, ImportCommandResult, StreamingFetchLike };
export { DEFAULT_IMPORT_BATCH_SIZE, runExportCommand, runImportCommand };
