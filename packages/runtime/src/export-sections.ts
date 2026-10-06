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
 * `value` the base64 of the stored bytes. A value too large for one line is
 * written as `{ namespace, key, tooLarge: true, size }` and reported on import.
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
 * multi-chunk object to a staging object (`_lunora/restore/…`) as it arrives —
 * the chunks of one object span several import requests — and assembles the
 * object when its last chunk lands.
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
 * Raw bytes per storage chunk and the largest KV value written inline. Base64
 * makes 512 KiB about 700 KB, which leaves room for the envelope under a
 * restore's ~900 KB batch.
 */
const SECTION_CHUNK_BYTES: number = 512 * 1024;

/** Objects under this prefix are Lunora's own (resumable-upload state, restore staging), never exported. */
const RESERVED_STORAGE_PREFIX = "_lunora/";

const RESTORE_STAGING_PREFIX = `${RESERVED_STORAGE_PREFIX}restore/`;

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

/** Re-cut a stream into `size`-byte pieces; the final one may be shorter, and an empty stream yields none. */
const fixedChunks = async function* fixedChunks(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
    let buffer = new Uint8Array(size);
    let filled = 0;

    for await (const value of streamValues(stream)) {
        for (let offset = 0; offset < value.byteLength;) {
            const take = Math.min(size - filled, value.byteLength - offset);

            buffer.set(value.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;

            if (filled === size) {
                yield buffer;
                buffer = new Uint8Array(size);
                filled = 0;
            }
        }
    }

    if (filled > 0) {
        yield buffer.subarray(0, filled);
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

/** The byte length a base64 string decodes to. */
const base64Size = (value: string): number => {
    const padding = value.endsWith("==") ? 2 : Number(value.endsWith("="));

    return (value.length * 3) / 4 - padding;
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

const exportKv = async function* exportKv(kv: KvIntrospector): AsyncGenerator<ExportRow> {
    for (const { binding: namespace } of await kv.listNamespaces()) {
        // eslint-disable-next-line no-await-in-loop -- namespaces one at a time
        for await (const entry of kvKeys(kv, namespace)) {
            const { metadata, value } = await kv.getValue({ encoding: "base64", key: entry.name, namespace });

            // Deleted between the listing and the read.
            if (value === null) {
                continue;
            }

            const size = base64Size(value);

            if (size > SECTION_CHUNK_BYTES) {
                yield { doc: { key: entry.name, namespace, size, tooLarge: true }, table: KV_TABLE };
                continue;
            }

            yield {
                doc: {
                    key: entry.name,
                    namespace,
                    value,
                    ...(metadata === null || metadata === undefined ? {} : { metadata }),
                    ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }),
                },
                table: KV_TABLE,
            };
        }
    }
};

/** Every object of one bucket outside the reserved prefix, following the listing's cursor. */
const storageObjects = async function* storageObjects(
    list: NonNullable<WorkerOptions["storageList"]>,
    bucket: string | undefined,
): AsyncGenerator<StorageObject> {
    let cursor: string | undefined;
    let more = true;

    while (more) {
        // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
        const page = await list(undefined, { bucket, cursor, limit: LIST_PAGE_SIZE });

        yield* page.objects.filter((object) => !object.key.startsWith(RESERVED_STORAGE_PREFIX));
        cursor = page.cursor;
        more = cursor !== undefined && (page.truncated ?? true);
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

    for await (const { bytes, last } of flagLast(fixedChunks(downloaded.body as ReadableStream<Uint8Array>, SECTION_CHUNK_BYTES))) {
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

const importKvRow = async (options: WorkerOptions, row: SectionRow, totals: SectionTotals): Promise<void> => {
    const kv = options.kvIntrospector;
    const { expiration, key, metadata, namespace, tooLarge, value } = row.doc;

    if (!kv) {
        rowError(totals, row, "KV_NOT_CONFIGURED", "row targets a KV namespace but this worker has no `kvIntrospector`");

        return;
    }

    if (typeof namespace !== "string" || typeof key !== "string") {
        rowError(totals, row, "BAD_ROW", "a `$kv` record needs a string `namespace` and `key`");

        return;
    }

    if (tooLarge === true) {
        rowError(totals, row, "KV_VALUE_TOO_LARGE", `KV value ${namespace}/${key} was over ${String(SECTION_CHUNK_BYTES)} bytes and is not in the export`);

        return;
    }

    if (typeof value !== "string" || (expiration !== undefined && typeof expiration !== "number")) {
        rowError(totals, row, "BAD_ROW", "a `$kv` record needs a base64 string `value` and a numeric `expiration` if any");

        return;
    }

    try {
        // Append-only like the table import: a key that exists now is left alone, and
        // one that has expired since the export (or would before KV accepts it) is
        // gone already, so neither is written.
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
    } catch (error) {
        rowError(totals, row, "KV_IMPORT_FAILED", `KV ${namespace}/${key}: ${errorMessage(error)}`);
    }
};

/** A validated `$storage` record. */
interface StorageRecord {
    bytes: Uint8Array<ArrayBuffer>;
    key: string;
    /** `size` of the whole object on the last chunk; `undefined` on the others. */
    lastSize: number | undefined;
    offset: number;
    /** The upload options of the final object. */
    upload: { bucket?: string; contentType?: string; customMetadata?: Record<string, string>; sha256?: string };
    /** Where it lives: the bucket, also where its chunks are staged. */
    where: { bucket?: string };
}

const parseStorageRecord = (document: Record<string, unknown>): StorageRecord | undefined => {
    const { bucket, contentType, customMetadata, data, key, last, offset, sha256, size } = document;
    const validLast = last !== true || (typeof size === "number" && Number.isInteger(size) && size >= 0);

    if (typeof key !== "string" || typeof data !== "string" || !Number.isInteger(offset) || (offset as number) < 0 || !validLast) {
        return undefined;
    }

    if (bucket !== undefined && typeof bucket !== "string") {
        return undefined;
    }

    const where = bucket === undefined ? {} : { bucket };

    return {
        bytes: fromBase64(data),
        key,
        lastSize: last === true ? (size as number) : undefined,
        offset: offset as number,
        upload: {
            ...where,
            ...(typeof contentType === "string" ? { contentType } : {}),
            ...(isRecord(customMetadata) ? { customMetadata: customMetadata as Record<string, string> } : {}),
            ...(typeof sha256 === "string" ? { sha256 } : {}),
        },
        where,
    };
};

/** Where a chunk of a multi-chunk object waits until its last chunk arrives. */
const stagingPrefix = async (record: StorageRecord): Promise<string> =>
    `${RESTORE_STAGING_PREFIX}${toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${record.where.bucket ?? ""}\u0000${record.key}`)))}/`;

const stagingKey = (prefix: string, offset: number): string => `${prefix}${String(offset).padStart(16, "0")}`;

const objectExists = async (options: WorkerOptions, record: StorageRecord): Promise<boolean> => {
    const existing = await options.storageDownload?.(record.key, record.where);

    await existing?.body?.cancel();

    return existing !== null && existing !== undefined;
};

/** Read the staged chunks in front of the last one back into a buffer of the object's size. */
const assembleStaged = async (
    download: NonNullable<WorkerOptions["storageDownload"]>,
    record: StorageRecord,
    prefix: string,
    size: number,
): Promise<{ buffer: Uint8Array<ArrayBuffer>; staged: string[] } | string> => {
    const buffer = new Uint8Array(size);
    const staged: string[] = [];
    let position = 0;

    while (position < record.offset) {
        const partKey = stagingKey(prefix, position);
        // eslint-disable-next-line no-await-in-loop -- parts are read back in order
        const part = await download(partKey, record.where);

        if (!part?.body) {
            return `the chunk at byte ${String(position)} never arrived`;
        }

        // eslint-disable-next-line no-await-in-loop -- parts are read back in order
        const bytes = new Uint8Array(await new Response(part.body).arrayBuffer());

        if (position + bytes.byteLength > record.offset) {
            return `the chunk at byte ${String(position)} overlaps the last chunk`;
        }

        buffer.set(bytes, position);
        staged.push(partKey);
        position += bytes.byteLength;
    }

    if (record.offset + record.bytes.byteLength !== size) {
        return `chunks add up to ${String(record.offset + record.bytes.byteLength)} of ${String(size)} bytes`;
    }

    buffer.set(record.bytes, record.offset);

    return { buffer, staged };
};

/** The last chunk of a multi-chunk object: read the staged chunks back, write the object, drop the staging. */
const finishStagedObject = async (options: WorkerOptions, row: SectionRow, record: StorageRecord, size: number, totals: SectionTotals): Promise<void> => {
    const { storageDelete, storageDownload, storageUpload } = options;

    // ponytail: an object is assembled in memory, so restore stops at the 32 MiB the
    // upload route also buffers; a multipart upload from the staged chunks lifts it.
    if (size > STORAGE_UPLOAD_MAX_BODY_BYTES) {
        rowError(
            totals,
            row,
            "STORAGE_OBJECT_TOO_LARGE",
            `${record.key} is ${String(size)} bytes; restoring objects over ${String(STORAGE_UPLOAD_MAX_BODY_BYTES)} bytes is not supported (the export holds it)`,
        );

        return;
    }

    if (!storageUpload || !storageDownload || !storageDelete) {
        rowError(
            totals,
            row,
            "STORAGE_NOT_CONFIGURED",
            "restoring a multi-chunk object needs `storageUpload`, `storageDownload` and `storageDelete` on the worker",
        );

        return;
    }

    const assembled = await assembleStaged(storageDownload, record, await stagingPrefix(record), size);

    if (typeof assembled === "string") {
        rowError(totals, row, "STORAGE_RESTORE_INCOMPLETE", `${record.key}: ${assembled}`);

        return;
    }

    if (await objectExists(options, record)) {
        conflict(totals);
    } else {
        await storageUpload(record.key, assembled.buffer.buffer, record.upload);
        count(totals, STORAGE_TABLE);
    }

    await Promise.all(assembled.staged.map(async (partKey) => storageDelete(partKey, record.where)));
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

    if (record.lastSize !== undefined) {
        await finishStagedObject(options, row, record, record.lastSize, totals);

        return;
    }

    // Past the ceiling the object cannot be assembled anyway; its last chunk
    // reports it, so the chunks in front of it are not staged for nothing.
    if (record.offset + record.bytes.byteLength <= STORAGE_UPLOAD_MAX_BODY_BYTES) {
        await upload(stagingKey(await stagingPrefix(record), record.offset), record.bytes.buffer, record.where);
        count(totals, STORAGE_TABLE);
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
