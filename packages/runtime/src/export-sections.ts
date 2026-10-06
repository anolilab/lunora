/**
 * The non-table sections of the admin export (`/_lunora/admin/export`) and their
 * import half: auth tables that live outside the schema, KV namespaces, and the
 * objects in the app's `@lunora/storage` buckets.
 *
 * ## Format
 *
 * The export stays one NDJSON stream of `{ table, doc }` lines. A section's
 * records ride the same envelope under a reserved `$`-prefixed table name, so
 * every tool that moves lines without reading them (`lunora import`'s batcher,
 * the cloud restore, `lunora backup`) carries them unchanged.
 *
 * `$lunora` is the header and the first line, `{ format: 2, sections: [...] }`.
 * A file without one is format 1 (schema tables only), which is exactly what an
 * export that includes no section still writes, byte for byte.
 *
 * `$auth` is one auth-table row, `{ table, row }`; `row` is wire-encoded
 * (`shared/wire-codec`), so a byte column survives.
 *
 * `$kv` is one entry, `{ namespace, key, value, metadata?, expiration? }`, with
 * `value` the base64 of the stored bytes. A value over {@link SECTION_CHUNK_BYTES}
 * is cut into chunks like a storage object, `{ namespace, key, offset, data }`,
 * with `last: true, size, sha256, metadata?, expiration?` on the final chunk.
 *
 * `$storage` is one chunk of one object, `{ bucket?, key, offset, data }`, with
 * `last: true, size, contentType?, customMetadata?, sha256?` on the final chunk;
 * `data` is the base64 of at most {@link SECTION_CHUNK_BYTES} bytes.
 *
 * Every line stays under the ~900 KB a restore batches into one import request
 * (the import reads its body under the runtime's 1 MiB cap).
 *
 * ## Memory
 *
 * Export holds one KV value, or a few storage chunks, at a time: objects are
 * streamed off their body, never read whole. Import writes each chunk of a
 * multi-chunk value or object to a staging object (`_lunora/restore/…`, see
 * `section-chunks.ts`) as it arrives — the chunks span several import
 * requests — and assembles it when its last chunk lands. A KV value (at most
 * 25 MiB) is assembled in memory: the KV port writes a base64 string, so there
 * is no stream to hand it. A storage object up to 32 MiB is assembled in memory
 * and written with one checksummed put; a larger one goes through a multipart
 * upload in parts of at least 5 MiB, holding one part at a time.
 *
 * Vectorize is not a section: the binding can query, upsert and fetch vectors by
 * id, but cannot enumerate them (only the account-token REST API can, which a
 * worker does not hold), so there is no way to read an index back out.
 */
import { fromBase64, toBase64 } from "../../../shared/base64";
import type { StorageObject, WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { ExportRow } from "./export-stream";
import type { ImportRowError } from "./import-stream";
import type { KvIntrospector } from "./kv-admin-routes";
import type { ChunkRecord, StagingStore } from "./section-chunks";
import {
    collectChunks,
    currentSession,
    deleteSession,
    fixedChunks,
    listAll,
    parseChunk,
    stageChunk,
    stagedChunks,
    stagingRoot,
    stagingStore,
    sweepStaleStaging,
    uploadMultipart,
} from "./section-chunks";
import { STORAGE_UPLOAD_MAX_BODY_BYTES, toHex } from "./storage-admin-routes";

/** The export stream's format version. 1 is a file with no header (schema tables only). */
const EXPORT_FORMAT_VERSION = 2;

const HEADER_TABLE = "$lunora";
const AUTH_TABLE = "$auth";
const KV_TABLE = "$kv";
const STORAGE_TABLE = "$storage";

/** The pseudo-table names a section record uses. */
const SECTION_TABLES: ReadonlySet<string> = new Set([AUTH_TABLE, HEADER_TABLE, KV_TABLE, STORAGE_TABLE]);

/** Exportable sections, in the order they are written. */
const EXPORT_SECTIONS = ["auth", "kv", "storage"] as const;

/**
 * What a whole-deployment export carries when it names no `sections`. Not `auth`:
 * every end user's password hash and second factor is the most sensitive thing a
 * deployment holds, so it leaves only when the caller asks for it by name.
 */
const DEFAULT_EXPORT_SECTIONS: ReadonlyArray<ExportSection> = ["kv", "storage"];

type ExportSection = (typeof EXPORT_SECTIONS)[number];

/**
 * Raw bytes per chunk, and the largest KV value written inline. Base64 makes
 * 512 KiB about 700 KB, which leaves room for the envelope under a restore's
 * ~900 KB batch.
 */
const SECTION_CHUNK_BYTES: number = 512 * 1024;

/** Workers KV's largest value. */
const KV_MAX_VALUE_BYTES: number = 25 * 1024 * 1024;

/** Objects under this prefix are Lunora's own (resumable-upload state, restore staging), never exported. */
const RESERVED_STORAGE_PREFIX = "_lunora/";

/** KV refuses an absolute expiration closer than this many seconds. */
const KV_MIN_EXPIRATION_SECONDS = 60;

const LIST_PAGE_SIZE = 1000;

/**
 * The auth tables that live outside the schema — better-auth's tables in the auth
 * D1 database, or every table of the DO-backed auth object. `@lunora/auth`'s
 * `createSqlAuthDataPort` / `createDoAuthWiring(...).dataPort` build one.
 */
interface AuthDataPort {
    /** Every row of every auth table, parents (`user`) before the rows that reference them. */
    exportRows: () => AsyncIterable<{ doc: Record<string, unknown>; table: string }>;

    /** Insert rows, skipping any whose key already exists (append-only, like the table import). `index` is the row's position in `rows`. */
    importRows: (rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>) => Promise<{
        conflicts: number;
        errors: ReadonlyArray<{ index: number; message: string; table: string }>;
        inserted: number;
    }>;
}

/** The sections this worker can export, out of those asked for. */
const availableSections = (options: WorkerOptions, requested: ReadonlyArray<ExportSection>): ExportSection[] =>
    requested.filter((section) => {
        switch (section) {
            case "auth": {
                return options.authData !== undefined;
            }
            case "kv": {
                return options.kvIntrospector !== undefined;
            }
            case "storage": {
                return options.storageList !== undefined && options.storageDownload !== undefined;
            }
            default: {
                return false;
            }
        }
    });

/** A stream's chunks; cancels the stream if the consumer stops early. */
const streamValues = async function* streamValues(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    let finished = false;

    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- a stream is read sequentially by construction
            const { done, value } = await reader.read();

            if (done) {
                finished = true;

                return;
            }

            yield value;
        }
    } finally {
        if (!finished) {
            await reader.cancel().catch(() => {});
        }
    }
};

/** Flag the final chunk, holding one back to know it. An empty stream is one empty, final chunk. */
const flagLast = async function* flagLast(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<{ bytes: Uint8Array; last: boolean }> {
    let pending: Uint8Array | undefined;

    for await (const chunk of chunks) {
        if (pending) {
            yield { bytes: pending, last: false };
        }

        pending = chunk;
    }

    yield { bytes: pending ?? new Uint8Array(0), last: true };
};

/** Every key of one namespace, following the listing's cursor. */
const kvKeys = async function* kvKeys(kv: KvIntrospector, namespace: string): AsyncGenerator<{ expiration?: number; name: string }> {
    let cursor: string | undefined;

    do {
        // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
        const page = await kv.listKeys({ cursor, limit: LIST_PAGE_SIZE, namespace });

        yield* page.keys;
        cursor = page.listComplete ? undefined : page.cursor;
    } while (cursor !== undefined);
};

/** One KV value's records: inline up to {@link SECTION_CHUNK_BYTES}, else chunks with the size, digest and `extras` on the last. */
const kvRecords = async function* kvRecords(
    where: { key: string; namespace: string },
    value: string,
    extras: Record<string, unknown>,
): AsyncGenerator<ExportRow> {
    const bytes = fromBase64(value);

    if (bytes.byteLength <= SECTION_CHUNK_BYTES) {
        yield { doc: { ...where, value, ...extras }, table: KV_TABLE };

        return;
    }

    const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));

    for (let offset = 0; offset < bytes.byteLength; offset += SECTION_CHUNK_BYTES) {
        const data = toBase64(bytes.subarray(offset, offset + SECTION_CHUNK_BYTES));
        const tail = offset + SECTION_CHUNK_BYTES >= bytes.byteLength ? { last: true, sha256, size: bytes.byteLength, ...extras } : {};

        yield { doc: { ...where, data, offset, ...tail }, table: KV_TABLE };
    }
};

const exportKv = async function* exportKv(kv: KvIntrospector): AsyncGenerator<ExportRow> {
    for (const { binding: namespace } of await kv.listNamespaces()) {
        // eslint-disable-next-line no-await-in-loop -- namespaces one at a time
        for await (const entry of kvKeys(kv, namespace)) {
            const { metadata, value } = await kv.getValue({ encoding: "base64", key: entry.name, namespace });

            // Deleted between the listing and the read.
            if (value === null) {
                continue;
            }

            yield* kvRecords({ key: entry.name, namespace }, value, {
                ...(metadata === null || metadata === undefined ? {} : { metadata }),
                ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }),
            });
        }
    }
};

/** Every object of one bucket outside the reserved prefix, following the listing's cursor. */
const storageObjects = async function* storageObjects(
    list: NonNullable<WorkerOptions["storageList"]>,
    bucket: string | undefined,
): AsyncGenerator<StorageObject> {
    for await (const object of listAll(list, undefined, bucket === undefined ? {} : { bucket })) {
        if (!object.key.startsWith(RESERVED_STORAGE_PREFIX)) {
            yield object;
        }
    }
};

/** What only the last chunk of an object carries: its size, and what it is re-uploaded with. */
const storageTail = (object: StorageObject, contentType: string | undefined, size: number): Record<string, unknown> => {
    return {
        last: true,
        size,
        ...(contentType === undefined ? {} : { contentType }),
        ...(object.customMetadata === undefined || Object.keys(object.customMetadata).length === 0 ? {} : { customMetadata: object.customMetadata }),
        ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
    };
};

/** One object's chunk records, streamed off its body. */
const objectRecords = async function* objectRecords(
    object: StorageObject,
    bucket: string | undefined,
    downloaded: { body: ReadableStream; httpMetadata?: { contentType?: string } },
): AsyncGenerator<ExportRow> {
    const where = bucket === undefined ? { key: object.key } : { bucket, key: object.key };
    const contentType = object.httpMetadata?.contentType ?? downloaded.httpMetadata?.contentType;
    let offset = 0;

    for await (const { bytes, last } of flagLast(fixedChunks(streamValues(downloaded.body as ReadableStream<Uint8Array>), SECTION_CHUNK_BYTES))) {
        const tail = last ? storageTail(object, contentType, offset + bytes.byteLength) : {};

        yield { doc: { ...where, data: toBase64(bytes), offset, ...tail }, table: STORAGE_TABLE };
        offset += bytes.byteLength;
    }
};

const exportStorage = async function* exportStorage(
    list: NonNullable<WorkerOptions["storageList"]>,
    download: NonNullable<WorkerOptions["storageDownload"]>,
    buckets: ReadonlyArray<string | undefined>,
): AsyncGenerator<ExportRow> {
    for (const bucket of buckets) {
        // eslint-disable-next-line no-await-in-loop -- buckets one at a time
        for await (const object of storageObjects(list, bucket)) {
            const downloaded = await download(object.key, { bucket });

            // Deleted between the listing and the read.
            if (downloaded?.body) {
                yield* objectRecords(object, bucket, { body: downloaded.body, httpMetadata: downloaded.httpMetadata });
            }
        }
    }
};

const exportAuth = async function* exportAuth(authData: AuthDataPort): AsyncGenerator<ExportRow> {
    for await (const row of authData.exportRows()) {
        yield { doc: { row: row.doc, table: row.table }, table: AUTH_TABLE };
    }
};

/**
 * The header and the records of the requested sections this worker can export.
 * Neither when none of them is configured, so an export of schema tables alone
 * is the format-1 stream it always was.
 */
const exportSectionRows = (
    options: WorkerOptions,
    requested: ReadonlyArray<ExportSection>,
): { header: ExportRow | undefined; rows: AsyncIterable<ExportRow> } => {
    const sections = availableSections(options, requested);
    const { authData, kvIntrospector, storageDownload, storageList } = options;

    return {
        header: sections.length === 0 ? undefined : { doc: { format: EXPORT_FORMAT_VERSION, sections }, table: HEADER_TABLE },
        rows: (async function* rows(): AsyncGenerator<ExportRow> {
            if (authData && sections.includes("auth")) {
                yield* exportAuth(authData);
            }

            if (kvIntrospector && sections.includes("kv")) {
                yield* exportKv(kvIntrospector);
            }

            if (storageList && storageDownload && sections.includes("storage")) {
                // A single-bucket worker declares no names: its one bucket is the default.
                yield* exportStorage(storageList, storageDownload, options.storageBuckets ?? [undefined]);
            }
        })(),
    };
};

/** Refuse a header from a newer format before anything of the file is written. */
const assertSupportedHeader = (document: Record<string, unknown>): void => {
    const { format } = document;

    if (typeof format !== "number" || !Number.isInteger(format) || format < 1 || format > EXPORT_FORMAT_VERSION) {
        throw new LunoraError(`Import format ${JSON.stringify(format)} is not supported (this runtime reads formats 1-${String(EXPORT_FORMAT_VERSION)})`, {
            code: "IMPORT_FORMAT_UNSUPPORTED",
            status: 400,
        });
    }
};

/** One section line of an import body, with its physical source line. */
type SectionRow = { doc: Record<string, unknown>; line: number; table: string };

interface SectionTotals {
    conflicts: number;
    errors: ImportRowError[];
    inserted: Record<string, number>;
}

const count = (totals: SectionTotals, table: string, by = 1): void => {
    // eslint-disable-next-line no-param-reassign -- caller-owned accumulator
    totals.inserted[table] = (totals.inserted[table] ?? 0) + by;
};

const conflict = (totals: SectionTotals): void => {
    // eslint-disable-next-line no-param-reassign -- caller-owned accumulator
    totals.conflicts += 1;
};

const rowError = (totals: SectionTotals, row: SectionRow, code: string, message: string): void => {
    totals.errors.push({ code, line: row.line, message, table: row.table });
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const importAuth = async (options: WorkerOptions, rows: ReadonlyArray<SectionRow>, totals: SectionTotals): Promise<void> => {
    const valid: { doc: Record<string, unknown>; row: SectionRow; table: string }[] = [];

    for (const row of rows) {
        const { row: document, table } = row.doc;

        if (typeof table !== "string" || !isRecord(document)) {
            rowError(totals, row, "BAD_ROW", "an `$auth` record needs a string `table` and an object `row`");
        } else if (options.authData) {
            valid.push({ doc: document, row, table });
        } else {
            rowError(totals, row, "AUTH_NOT_CONFIGURED", "row targets an auth table but this worker has no auth data port (`authData`)");
        }
    }

    if (valid.length === 0 || !options.authData) {
        return;
    }

    const result = await options.authData.importRows(
        valid.map(({ doc, table }) => {
            return { doc, table };
        }),
    );

    count(totals, AUTH_TABLE, result.inserted);
    // eslint-disable-next-line no-param-reassign -- caller-owned accumulator
    totals.conflicts += result.conflicts;

    for (const error of result.errors) {
        const source = valid[error.index]?.row;

        totals.errors.push({ code: "AUTH_IMPORT_FAILED", line: source?.line ?? 0, message: error.message, table: AUTH_TABLE });
    }
};

/** Where one target's chunks are staged, and the prefix of the error codes it reports. */
interface Staging {
    kind: "KV" | "STORAGE";
    root: string;
    where: { bucket?: string };
}

const isAssemblyError = (error: unknown): error is LunoraError =>
    error instanceof LunoraError && (error.code.endsWith("_RESTORE_INCOMPLETE") || error.code.endsWith("_SHA256_MISMATCH"));

/** Stage a chunk in front of the last, or report that the first chunk never opened a session for it. */
const stageOrReport = async (store: StagingStore, row: SectionRow, staging: Staging, chunk: ChunkRecord, totals: SectionTotals): Promise<void> => {
    if (await stageChunk(store, staging.root, staging.where, chunk)) {
        count(totals, row.table);
    } else {
        rowError(
            totals,
            row,
            `${staging.kind}_RESTORE_INCOMPLETE`,
            `the chunk at byte 0 never arrived, so the one at byte ${String(chunk.offset)} has nothing to join`,
        );
    }
};

/**
 * The last chunk: hand `write` the staged chunks in order, then drop the
 * session. A gap or a digest mismatch is reported on the row and the session
 * dropped too, since no retry of this line can complete it; any other failure
 * propagates and leaves the session for the next import's sweep.
 */
const finishStaged = async (
    store: StagingStore,
    row: SectionRow,
    staging: Staging,
    last: ChunkRecord,
    totals: SectionTotals,
    write: (chunks: AsyncIterable<Uint8Array>) => Promise<void>,
): Promise<void> => {
    const session = last.offset === 0 ? undefined : await currentSession(store, staging.root, staging.where);

    if (last.offset > 0 && session === undefined) {
        rowError(totals, row, `${staging.kind}_RESTORE_INCOMPLETE`, "the chunk at byte 0 never arrived");

        return;
    }

    try {
        await write(stagedChunks(store, staging.where, session ?? "", last, staging.kind));
    } catch (error) {
        if (!isAssemblyError(error)) {
            throw error;
        }

        rowError(totals, row, error.code, error.message);
    }

    if (session !== undefined) {
        await deleteSession(store, session, staging.where);
    }
};

/** One KV key an import writes. */
interface KvTarget {
    expiration: number | undefined;
    key: string;
    kv: KvIntrospector;
    metadata: unknown;
    namespace: string;
}

/**
 * Append-only like the table import: a key that exists now is left alone, and
 * one that has expired since the export (or would before KV accepts it) is gone
 * already, so neither is written.
 */
const putKvValue = async (target: KvTarget, value: string, totals: SectionTotals): Promise<void> => {
    const { expiration, key, kv, metadata, namespace } = target;
    const existing = await kv.getValue({ key, namespace });
    const expired = expiration !== undefined && expiration < Math.floor(Date.now() / 1000) + KV_MIN_EXPIRATION_SECONDS;

    if (existing.value !== null || expired) {
        conflict(totals);

        return;
    }

    await kv.putValue({
        encoding: "base64",
        key,
        namespace,
        value,
        ...(expiration === undefined ? {} : { expiration }),
        ...(metadata === undefined ? {} : { metadata }),
    });
    count(totals, KV_TABLE);
};

/**
 * One chunk of a value over {@link SECTION_CHUNK_BYTES}. KV has no staging of
 * its own that reads back consistently, so the chunks wait in the default
 * storage bucket; the value is assembled in memory (25 MiB at most) because the
 * KV port writes a base64 string, not a stream.
 */
const importKvChunk = async (options: WorkerOptions, row: SectionRow, target: KvTarget, chunk: ChunkRecord, totals: SectionTotals): Promise<void> => {
    const store = stagingStore(options);
    const label = `KV value ${target.namespace}/${target.key}`;

    // Both reported once, on the last chunk; the chunks in front of it are not staged for nothing.
    if (!store || chunk.offset + chunk.bytes.byteLength > KV_MAX_VALUE_BYTES) {
        if (chunk.lastSize !== undefined && !store) {
            rowError(
                totals,
                row,
                "KV_STAGING_NOT_CONFIGURED",
                `${label} is over ${String(SECTION_CHUNK_BYTES)} bytes; its chunks are staged in the default storage bucket, and this worker has no storage ops`,
            );
        } else if (chunk.lastSize !== undefined) {
            rowError(totals, row, "KV_VALUE_TOO_LARGE", `${label} is ${String(chunk.lastSize)} bytes, over KV's ${String(KV_MAX_VALUE_BYTES)}`);
        }

        return;
    }

    const staging: Staging = { kind: "KV", root: await stagingRoot(`kv\u0000${target.namespace}\u0000${target.key}`), where: {} };
    const size = chunk.lastSize;

    await (size === undefined
        ? stageOrReport(store, row, staging, chunk, totals)
        : finishStaged(store, row, staging, chunk, totals, async (chunks) => putKvValue(target, toBase64(await collectChunks(chunks, size)), totals)));
};

const importKvRow = async (options: WorkerOptions, row: SectionRow, totals: SectionTotals): Promise<void> => {
    const kv = options.kvIntrospector;
    const { expiration, key, metadata, namespace, value } = row.doc;

    if (!kv) {
        rowError(totals, row, "KV_NOT_CONFIGURED", "row targets a KV namespace but this worker has no `kvIntrospector`");

        return;
    }

    if (typeof namespace !== "string" || typeof key !== "string") {
        rowError(totals, row, "BAD_ROW", "a `$kv` record needs a string `namespace` and `key`");

        return;
    }

    const chunk = value === undefined ? parseChunk(row.doc) : undefined;

    if ((typeof value !== "string" && !chunk) || (expiration !== undefined && typeof expiration !== "number")) {
        rowError(totals, row, "BAD_ROW", "a `$kv` record needs a base64 string `value` (or a chunk's `data` and `offset`) and a numeric `expiration` if any");

        return;
    }

    const target = { expiration, key, kv, metadata, namespace };

    try {
        if (typeof value === "string") {
            await putKvValue(target, value, totals);
        } else if (chunk) {
            await importKvChunk(options, row, target, chunk, totals);
        }
    } catch (error) {
        rowError(totals, row, "KV_IMPORT_FAILED", `KV ${namespace}/${key}: ${errorMessage(error)}`);
    }
};

/** A validated `$storage` record: one chunk, and the object it belongs to. */
interface StorageRecord extends ChunkRecord {
    key: string;
    /** The upload options of the final object. */
    upload: { bucket?: string; contentType?: string; customMetadata?: Record<string, string>; sha256?: string };
    /** Where it lives: the bucket, also where its chunks are staged. */
    where: { bucket?: string };
}

const parseStorageRecord = (document: Record<string, unknown>): StorageRecord | undefined => {
    const { bucket, contentType, customMetadata, key } = document;
    const chunk = parseChunk(document);

    if (typeof key !== "string" || !chunk || (bucket !== undefined && typeof bucket !== "string")) {
        return undefined;
    }

    const where = bucket === undefined ? {} : { bucket };

    return {
        ...chunk,
        key,
        upload: {
            ...where,
            ...(typeof contentType === "string" ? { contentType } : {}),
            ...(isRecord(customMetadata) ? { customMetadata: customMetadata as Record<string, string> } : {}),
            ...(chunk.sha256 === undefined ? {} : { sha256: chunk.sha256 }),
        },
        where,
    };
};

const objectExists = async (options: WorkerOptions, record: StorageRecord): Promise<boolean> => {
    const existing = await options.storageDownload?.(record.key, record.where);

    await existing?.body?.cancel();

    return existing !== null && existing !== undefined;
};

/** The last chunk of a multi-chunk object: assemble it, in memory or through a multipart upload, unless it exists. */
const finishStagedObject = async (
    options: WorkerOptions,
    store: StagingStore,
    row: SectionRow,
    record: StorageRecord,
    staging: Staging,
    totals: SectionTotals,
): Promise<void> => {
    const size = record.lastSize ?? 0;
    const multipart = size > STORAGE_UPLOAD_MAX_BODY_BYTES ? options.storageMultipartUpload : undefined;

    if (size > STORAGE_UPLOAD_MAX_BODY_BYTES && !multipart) {
        rowError(
            totals,
            row,
            "STORAGE_OBJECT_TOO_LARGE",
            `${record.key} is ${String(size)} bytes; restoring an object over ${String(STORAGE_UPLOAD_MAX_BODY_BYTES)} bytes needs \`storageMultipartUpload\` on the worker (the export holds it)`,
        );

        return;
    }

    await finishStaged(store, row, staging, record, totals, async (chunks) => {
        if (await objectExists(options, record)) {
            conflict(totals);

            return;
        }

        if (multipart) {
            const { contentType, customMetadata } = record.upload;

            // No sha256 on the upload: R2 records none for a multipart object, so the
            // digest is checked as the chunks stream through instead.
            await uploadMultipart(await multipart(record.key, { ...record.where, contentType, customMetadata }), chunks, size);
        } else {
            const bytes = await collectChunks(chunks, size);

            await store.upload(record.key, bytes.buffer, record.upload);
        }

        count(totals, STORAGE_TABLE);
    });
};

const writeStorageRecord = async (options: WorkerOptions, row: SectionRow, record: StorageRecord, totals: SectionTotals): Promise<void> => {
    const upload = options.storageUpload;

    if (!upload) {
        rowError(totals, row, "STORAGE_NOT_CONFIGURED", "row targets a storage bucket but this worker has no `storageUpload`");

        return;
    }

    // The whole object in one line: written straight through.
    if (record.offset === 0 && record.lastSize !== undefined) {
        if (await objectExists(options, record)) {
            conflict(totals);
        } else {
            await upload(record.key, record.bytes.buffer, record.upload);
            count(totals, STORAGE_TABLE);
        }

        return;
    }

    const store = stagingStore(options);

    if (!store) {
        if (record.lastSize !== undefined) {
            rowError(
                totals,
                row,
                "STORAGE_NOT_CONFIGURED",
                "restoring a multi-chunk object needs `storageUpload`, `storageDownload`, `storageList` and `storageDelete` on the worker",
            );
        }

        return;
    }

    const staging: Staging = { kind: "STORAGE", root: await stagingRoot(`storage\u0000${record.where.bucket ?? ""}\u0000${record.key}`), where: record.where };

    if (record.lastSize !== undefined) {
        await finishStagedObject(options, store, row, record, staging, totals);
    } else if (options.storageMultipartUpload || record.offset + record.bytes.byteLength <= STORAGE_UPLOAD_MAX_BODY_BYTES) {
        // Past the in-memory ceiling without a multipart upload the object cannot
        // be assembled anyway; its last chunk reports it, so these are not staged.
        await stageOrReport(store, row, staging, record, totals);
    }
};

const importStorageRow = async (options: WorkerOptions, row: SectionRow, totals: SectionTotals): Promise<void> => {
    const record = parseStorageRecord(row.doc);

    if (!record) {
        rowError(totals, row, "BAD_ROW", "a `$storage` record needs a string `key` and base64 `data`, an integer `offset`, and a `size` on its last chunk");

        return;
    }

    try {
        await writeStorageRecord(options, row, record, totals);
    } catch (error) {
        rowError(totals, row, "STORAGE_IMPORT_FAILED", `${record.key}: ${errorMessage(error)}`);
    }
};

/**
 * A new import starts with its header: drop what earlier restores left staged
 * and never finished. A failed sweep is reported, never fatal — it frees space,
 * it does not decide what this import writes.
 */
const sweepStaging = async (options: WorkerOptions, row: SectionRow, totals: SectionTotals): Promise<void> => {
    const store = stagingStore(options);

    if (!store) {
        return;
    }

    try {
        await sweepStaleStaging(store, options.storageBuckets ?? [undefined], Date.now());
    } catch (error) {
        rowError(totals, row, "RESTORE_STAGING_SWEEP_FAILED", `could not delete stale staged chunks: ${errorMessage(error)}`);
    }
};

/**
 * Write one import request's section lines. Auth rows go in one batch; KV and
 * storage lines are written one at a time, in file order — a storage object's
 * chunks depend on it.
 */
const importSectionRows = async (options: WorkerOptions, rows: ReadonlyArray<SectionRow>): Promise<SectionTotals> => {
    const totals: SectionTotals = { conflicts: 0, errors: [], inserted: {} };

    await importAuth(
        options,
        rows.filter((row) => row.table === AUTH_TABLE),
        totals,
    );

    for (const row of rows) {
        switch (row.table) {
            case HEADER_TABLE: {
                count(totals, HEADER_TABLE);
                // eslint-disable-next-line no-await-in-loop -- the header is the import's first line
                await sweepStaging(options, row, totals);
                break;
            }
            case KV_TABLE: {
                // eslint-disable-next-line no-await-in-loop -- file order
                await importKvRow(options, row, totals);
                break;
            }
            case STORAGE_TABLE: {
                // eslint-disable-next-line no-await-in-loop -- a storage object's chunks are written in order
                await importStorageRow(options, row, totals);
                break;
            }
            default:
            // `$auth` rows went in the batch above.
        }
    }

    return totals;
};

/** Is this a section's pseudo-table (vs. a schema table)? */
const isSectionTable = (table: string): boolean => SECTION_TABLES.has(table);

export type { AuthDataPort, ExportSection, SectionRow };
export {
    assertSupportedHeader,
    DEFAULT_EXPORT_SECTIONS,
    EXPORT_FORMAT_VERSION,
    EXPORT_SECTIONS,
    exportSectionRows,
    HEADER_TABLE,
    importSectionRows,
    isSectionTable,
    SECTION_CHUNK_BYTES,
};
