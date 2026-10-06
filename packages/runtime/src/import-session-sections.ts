/**
 * The non-table sections (`./export-sections`) of a staged replace import
 * (`./import-session`): what staging does with each record, and the commit step
 * that makes the section exact.
 *
 * Staging writes nothing a reader sees. `$auth` records, single-line `$kv`
 * values and single-chunk objects wait in the root shard's staging table. A
 * value or object cut into chunks uses `./section-chunks`' records and sealing:
 * each chunk in front of the last is sealed under the admin token and uploaded
 * to `_lunora/restore-session/<session>/<generation>/<sha256 of target>/<offset>`,
 * and the last chunk waits on the root shard. When the last chunk arrives the
 * staged ones are read back and checked (no gap, the export's sha256), so a
 * value that cannot be assembled refuses the session before any commit.
 *
 * That prefix is disjoint from the append import's `_lunora/restore/` staging:
 * neither import's sweep lists, let alone deletes, the other's chunks. A
 * session's chunks are deleted only by its own commit, abort or expiry, by
 * their exact `<session>/<generation>/` prefix.
 *
 * At commit, a section the snapshot's header declares is replaced exactly. Auth
 * goes through the auth store's `replaceRows`, one transaction of that store. KV
 * writes every staged value, assembled from its chunks where it has them, then
 * deletes every key of every bound namespace the snapshot does not hold.
 * Storage writes every staged object — in memory up to 32 MiB, through a
 * multipart upload past that — then deletes every object outside `_lunora/`
 * the snapshot does not hold, then the session's chunks. KV and R2 have no
 * multi-key transaction, so those two are ordered rather than atomic: writes
 * first, deletes once every write landed, and a retried commit re-applies them.
 */
import { toBase64 } from "../../../shared/base64";
import type { StorageObject, WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { SectionRow, StorageRecord } from "./export-sections";
import {
    AUTH_TABLE,
    HEADER_TABLE,
    isRecord,
    KV_MAX_VALUE_BYTES,
    KV_MIN_EXPIRATION_SECONDS,
    KV_TABLE,
    kvKeys,
    parseStorageRecord,
    STORAGE_TABLE,
    storageObjects,
} from "./export-sections";
import type { ImportRowError } from "./import-stream";
import type { ChunkRecord, StagingStore } from "./section-chunks";
import { chunkKey, collectChunks, parseChunk, seal, stagedChunks, stagingStore, uploadMultipart } from "./section-chunks";
import { STORAGE_UPLOAD_MAX_BODY_BYTES, toHex } from "./storage-admin-routes";

/** The sections a replace can make exact, by the name the header lists them under. */
type ReplaceSection = "auth" | "kv" | "storage";

const REPLACE_SECTIONS: ReadonlyArray<ReplaceSection> = ["auth", "kv", "storage"];

/** Where a staged session's chunks live — never under the append import's `_lunora/restore/`. */
const SESSION_STAGING_PREFIX = "_lunora/restore-session/";

/** A staged section record, as the root shard keeps it. */
interface StagedSectionRow {
    doc: Record<string, unknown>;
    line: number;
    table: string;
}

/** What one commit step wrote. */
interface SectionStepResult {
    deleted: Record<string, number>;
    inserted: Record<string, number>;
    warnings?: string[];
}

/** The session a section call belongs to. */
interface SessionRef {
    generation: string;
    session: string;
}

type Where = { bucket?: string };

/** Where all of one session's chunks live. */
const sessionStagingPrefix = (ref: SessionRef): string => `${SESSION_STAGING_PREFIX}${ref.session}/${ref.generation}/`;

/** Where one target's chunks live inside the session's prefix: `scope` names the target (section, bucket or namespace, key). */
const targetPrefix = async (ref: SessionRef, scope: string): Promise<string> =>
    `${sessionStagingPrefix(ref)}${toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope)))}/`;

const kvScope = (namespace: string, key: string): string => `kv\u0000${namespace}\u0000${key}`;

const storageScope = (where: Where, key: string): string => `storage\u0000${where.bucket ?? ""}\u0000${key}`;

/** The sections a snapshot header declares, among those a replace can make exact. */
const headerSections = (rows: ReadonlyArray<SectionRow>): ReplaceSection[] => {
    const header = rows.find((row) => row.table === HEADER_TABLE);
    const declared = Array.isArray(header?.doc["sections"]) ? (header.doc["sections"] as unknown[]) : [];

    return REPLACE_SECTIONS.filter((section) => declared.includes(section));
};

const stageError = (errors: ImportRowError[], row: SectionRow, code: string, message: string): void => {
    errors.push({ code, line: row.line, message, table: row.table });
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Seal one chunk in front of the last into the target's prefix. */
const uploadChunk = async (store: StagingStore, prefix: string, where: Where, chunk: ChunkRecord): Promise<void> => {
    const key = chunkKey(prefix, chunk.offset);

    await store.upload(key, await seal(store.secret, key, chunk.bytes), where);
};

/**
 * Read a target's staged chunks back to the last one, so a gap or a digest
 * mismatch refuses the session at staging, never part-way through a commit.
 * Holds one chunk.
 */
const verifyChunks = async (
    store: StagingStore,
    prefix: string,
    where: Where,
    last: ChunkRecord,
    kind: "KV" | "STORAGE",
): Promise<undefined | { code: string; message: string }> => {
    try {
        let read = 0;

        // The iterator checks the order, the sum and the digest as it reads.
        for await (const chunk of stagedChunks(store, where, prefix, last, kind)) {
            read += chunk.byteLength;
        }

        return read === last.lastSize ? undefined : { code: `${kind}_RESTORE_INCOMPLETE`, message: `read ${String(read)} of ${String(last.lastSize)} bytes` };
    } catch (error) {
        return { code: error instanceof LunoraError ? error.code : `${kind}_RESTORE_INCOMPLETE`, message: errorMessage(error) };
    }
};

/**
 * Stage one chunk of a chunked value or object: one in front of the last is
 * uploaded; the last is checked against the staged ones and returned to wait on
 * the root shard. `undefined` for a chunk in front of the last, or a refusal.
 */
const stageChunked = async (
    store: StagingStore,
    row: SectionRow,
    errors: ImportRowError[],
    target: { kind: "KV" | "STORAGE"; prefix: string; where: Where },
    chunk: ChunkRecord,
): Promise<StagedSectionRow | undefined> => {
    if (chunk.lastSize === undefined) {
        await uploadChunk(store, target.prefix, target.where, chunk);

        return undefined;
    }

    const failure = await verifyChunks(store, target.prefix, target.where, chunk, target.kind);

    if (failure !== undefined) {
        stageError(errors, row, failure.code, failure.message);

        return undefined;
    }

    return { doc: row.doc, line: row.line, table: row.table };
};

/**
 * Auth tables a restore never writes — live sessions, one-time tokens and the
 * auth audit log (`@lunora/auth`'s `isUnmovableAuthTable`). The export never
 * carries them; a snapshot that does is refused at staging, before the commit
 * would refuse it part-way.
 */
const UNMOVABLE_AUTH_TABLES: ReadonlySet<string> = new Set(["__lunora_auth_audit__", "session", "verification"]);

const stageAuthRow = (row: SectionRow, errors: ImportRowError[]): StagedSectionRow | undefined => {
    if (typeof row.doc["table"] !== "string" || !isRecord(row.doc["row"])) {
        stageError(errors, row, "BAD_ROW", "an `$auth` record needs a string `table` and an object `row`");

        return undefined;
    }

    // SQLite resolves table names case-insensitively, so `"SESSION"` is `session`.
    if (UNMOVABLE_AUTH_TABLES.has(row.doc["table"].toLowerCase())) {
        stageError(errors, row, "BAD_ROW", `the auth table "${row.doc["table"]}" is never restored`);

        return undefined;
    }

    return { doc: row.doc, line: row.line, table: AUTH_TABLE };
};

const stageKvRow = async (options: WorkerOptions, ref: SessionRef, row: SectionRow, errors: ImportRowError[]): Promise<StagedSectionRow | undefined> => {
    const { expiration, key, namespace, value } = row.doc;

    if (typeof namespace !== "string" || typeof key !== "string" || (expiration !== undefined && typeof expiration !== "number")) {
        stageError(errors, row, "BAD_ROW", "a `$kv` record needs a string `namespace` and `key`, and a numeric `expiration` if any");

        return undefined;
    }

    if (typeof value === "string") {
        return { doc: row.doc, line: row.line, table: KV_TABLE };
    }

    const chunk = parseChunk(row.doc);

    if (!chunk) {
        stageError(errors, row, "BAD_ROW", "a `$kv` record needs a base64 string `value`, or a chunk's `data` and `offset`");

        return undefined;
    }

    const store = stagingStore(options);

    if (!store) {
        stageError(
            errors,
            row,
            "KV_STAGING_NOT_CONFIGURED",
            `KV value ${namespace}/${key} is chunked; staging its chunks needs the storage ops and an admin token`,
        );

        return undefined;
    }

    if (chunk.offset + chunk.bytes.byteLength > KV_MAX_VALUE_BYTES) {
        stageError(errors, row, "KV_VALUE_TOO_LARGE", `KV value ${namespace}/${key} is over KV's ${String(KV_MAX_VALUE_BYTES)} bytes`);

        return undefined;
    }

    return stageChunked(store, row, errors, { kind: "KV", prefix: await targetPrefix(ref, kvScope(namespace, key)), where: {} }, chunk);
};

const stageStorageRow = async (options: WorkerOptions, ref: SessionRef, row: SectionRow, errors: ImportRowError[]): Promise<StagedSectionRow | undefined> => {
    const record: StorageRecord | undefined = parseStorageRecord(row.doc);

    if (!record) {
        stageError(errors, row, "BAD_ROW", "a `$storage` record needs a string `key` and base64 `data`, an integer `offset`, and a `size` on its last chunk");

        return undefined;
    }

    // The whole object in one line: it waits on the root shard as it is.
    if (record.offset === 0 && record.lastSize !== undefined) {
        return { doc: row.doc, line: row.line, table: STORAGE_TABLE };
    }

    const store = stagingStore(options);

    if (!store) {
        stageError(errors, row, "STORAGE_NOT_CONFIGURED", "staging a multi-chunk object needs the four storage ops and an admin token");

        return undefined;
    }

    if (record.offset + record.bytes.byteLength > STORAGE_UPLOAD_MAX_BODY_BYTES && !options.storageMultipartUpload) {
        stageError(
            errors,
            row,
            "STORAGE_OBJECT_TOO_LARGE",
            `${record.key} is over ${String(STORAGE_UPLOAD_MAX_BODY_BYTES)} bytes; restoring it needs \`storageMultipartUpload\` on the worker`,
        );

        return undefined;
    }

    return stageChunked(
        store,
        row,
        errors,
        { kind: "STORAGE", prefix: await targetPrefix(ref, storageScope(record.where, record.key)), where: record.where },
        record,
    );
};

/**
 * Validate one request's section records and stage what the commit needs:
 * records for the root shard, and chunks under the session's prefix. Any
 * failure to stage a record is a refused row, never silently skipped.
 */
const stageSectionRows = async (
    options: WorkerOptions,
    ref: SessionRef,
    rows: ReadonlyArray<SectionRow>,
): Promise<{ errors: ImportRowError[]; rows: StagedSectionRow[]; sections: ReplaceSection[]; storage: boolean }> => {
    const errors: ImportRowError[] = [];
    const staged: StagedSectionRow[] = [];
    let storage = false;

    for (const row of rows) {
        let record: StagedSectionRow | undefined;

        try {
            switch (row.table) {
                case AUTH_TABLE: {
                    record = stageAuthRow(row, errors);
                    break;
                }
                case KV_TABLE: {
                    storage = true;
                    // eslint-disable-next-line no-await-in-loop -- a value's chunks are staged in file order
                    record = await stageKvRow(options, ref, row, errors);
                    break;
                }
                case STORAGE_TABLE: {
                    storage = true;
                    // eslint-disable-next-line no-await-in-loop -- an object's chunks are staged in file order
                    record = await stageStorageRow(options, ref, row, errors);
                    break;
                }
                default:
                // The header is read by `headerSections`; it stages nothing.
            }
        } catch (error) {
            stageError(errors, row, "SECTION_STAGING_FAILED", errorMessage(error));
        }

        if (record) {
            staged.push(record);
        }
    }

    return { errors, rows: staged, sections: headerSections(rows), storage };
};

/** Why this worker cannot replace `section` exactly, or `undefined` when it can. */
const sectionUnsupported = (options: WorkerOptions, section: string): string | undefined => {
    switch (section) {
        case "auth": {
            return options.authData?.replaceRows ? undefined : "the snapshot carries auth tables, but this worker's auth data port cannot replace them";
        }
        case "kv": {
            return options.kvIntrospector ? undefined : "the snapshot carries KV, but this worker has no `kvIntrospector`";
        }
        case "storage": {
            return options.storageList && options.storageDownload && options.storageUpload && options.storageDelete
                ? undefined
                : "the snapshot carries storage objects, but this worker lacks `storageList`, `storageDownload`, `storageUpload` or `storageDelete`";
        }
        default: {
            return `unknown section "${section}"`;
        }
    }
};

const commitAuth = async (options: WorkerOptions, records: AsyncIterable<StagedSectionRow>): Promise<SectionStepResult> => {
    const rows: { doc: Record<string, unknown>; table: string }[] = [];

    // ponytail: every auth row of the snapshot is held for the one transaction;
    // staging the swap inside the auth store lifts it if auth outgrows memory.
    for await (const record of records) {
        rows.push({ doc: record.doc["row"] as Record<string, unknown>, table: String(record.doc["table"]) });
    }

    const result = await (options.authData?.replaceRows?.(rows) ?? Promise.reject(new TypeError("auth replace is not configured")));

    if (result.errors.length > 0) {
        throw new LunoraError(`auth replace rolled back: ${result.errors.map((error) => error.message).join("; ")}`, {
            code: "AUTH_IMPORT_FAILED",
            status: 409,
        });
    }

    return { deleted: { [AUTH_TABLE]: result.deleted }, inserted: { [AUTH_TABLE]: result.inserted } };
};

/** A staging store, which a chunked record needs at commit as it did at staging. */
const requireStore = (options: WorkerOptions): StagingStore => {
    const store = stagingStore(options);

    if (!store) {
        throw new TypeError("restore staging needs the storage ops and an admin token");
    }

    return store;
};

/** A staged KV record's value as base64: inline, or assembled from its sealed chunks. */
const kvValue = async (options: WorkerOptions, ref: SessionRef, document_: Record<string, unknown>): Promise<string> => {
    if (typeof document_["value"] === "string") {
        return document_["value"];
    }

    const last = parseChunk(document_);

    if (last?.lastSize === undefined) {
        throw new TypeError("a staged KV record is neither a value nor a last chunk");
    }

    const prefix = await targetPrefix(ref, kvScope(String(document_["namespace"]), String(document_["key"])));

    return toBase64(await collectChunks(stagedChunks(requireStore(options), {}, prefix, last, "KV"), last.lastSize));
};

/** Write every staged KV record. Returns the keys the snapshot holds (`namespace\0key`). */
const writeKvRecords = async (
    options: WorkerOptions,
    ref: SessionRef,
    records: AsyncIterable<StagedSectionRow>,
): Promise<{ inserted: number; keep: Set<string> }> => {
    const kv = options.kvIntrospector;

    if (!kv) {
        throw new TypeError("kv replace is not configured");
    }

    const keep = new Set<string>();
    let inserted = 0;
    const nowSeconds = Math.floor(Date.now() / 1000);

    for await (const { doc } of records) {
        const namespace = String(doc["namespace"]);
        const key = String(doc["key"]);
        const { expiration, metadata } = doc;

        // Expired since the export (or too close for KV to accept): absent in the snapshot's present.
        if (typeof expiration === "number" && expiration < nowSeconds + KV_MIN_EXPIRATION_SECONDS) {
            continue;
        }

        await kv.putValue({
            encoding: "base64",
            key,
            namespace,
            value: await kvValue(options, ref, doc),
            ...(typeof expiration === "number" ? { expiration } : {}),
            ...(metadata === undefined ? {} : { metadata }),
        });
        keep.add(`${namespace}\u0000${key}`);
        inserted += 1;
    }

    return { inserted, keep };
};

/** Delete every key of one namespace the snapshot does not hold; returns how many. */
const pruneKvNamespace = async (kv: NonNullable<WorkerOptions["kvIntrospector"]>, namespace: string, keep: ReadonlySet<string>): Promise<number> => {
    const doomed: string[] = [];

    // Collected first, so the listing never pages over keys it is deleting.
    for await (const { name } of kvKeys(kv, namespace)) {
        if (!keep.has(`${namespace}\u0000${name}`)) {
            doomed.push(name);
        }
    }

    for (const key of doomed) {
        // eslint-disable-next-line no-await-in-loop -- KV deletes one key per call
        await kv.deleteKey({ key, namespace });
    }

    return doomed.length;
};

const commitKv = async (options: WorkerOptions, ref: SessionRef, records: AsyncIterable<StagedSectionRow>): Promise<SectionStepResult> => {
    const { inserted, keep } = await writeKvRecords(options, ref, records);
    const kv = options.kvIntrospector;
    let deleted = 0;

    for (const { binding: namespace } of (await kv?.listNamespaces()) ?? []) {
        // eslint-disable-next-line no-await-in-loop -- namespaces one at a time
        deleted += await pruneKvNamespace(kv as NonNullable<typeof kv>, namespace, keep);
    }

    return { deleted: { [KV_TABLE]: deleted }, inserted: { [KV_TABLE]: inserted } };
};

/** Every object key under `prefix` in one bucket. */
const keysUnder = async (list: NonNullable<WorkerOptions["storageList"]>, prefix: string, where: Where): Promise<string[]> => {
    const keys: string[] = [];
    let cursor: string | undefined;

    do {
        // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
        const page: { cursor?: string; objects: StorageObject[]; truncated?: boolean } = await list(prefix, { ...where, cursor, limit: 1000 });

        keys.push(...page.objects.map((object) => object.key).filter((key) => key.startsWith(prefix)));
        cursor = page.truncated === false ? undefined : page.cursor;
    } while (cursor !== undefined);

    return keys;
};

/**
 * Delete one session's chunks — exactly its `<session>/<generation>/` prefix —
 * from the default bucket (KV chunks) and every named one. A leftover chunk is
 * under `_lunora/`, invisible to the app and the export.
 */
const dropStagedObjects = async (options: WorkerOptions, ref: SessionRef): Promise<void> => {
    const { storageDelete, storageList } = options;

    if (!storageDelete || !storageList) {
        return;
    }

    for (const bucket of new Set([undefined, ...(options.storageBuckets ?? [])])) {
        const where = bucket === undefined ? {} : { bucket };
        // eslint-disable-next-line no-await-in-loop -- buckets one at a time
        const keys = await keysUnder(storageList, sessionStagingPrefix(ref), where);

        // eslint-disable-next-line no-await-in-loop -- as above
        await Promise.all(keys.map(async (key) => storageDelete(key, where)));
    }
};

/** Write one staged object: straight through, assembled in memory, or through a multipart upload. */
const writeObject = async (options: WorkerOptions, ref: SessionRef, record: StorageRecord): Promise<void> => {
    const upload = options.storageUpload;

    if (!upload) {
        throw new TypeError("storage replace is not configured");
    }

    const size = record.lastSize ?? 0;

    if (record.offset === 0) {
        await upload(record.key, record.bytes.buffer, record.upload);

        return;
    }

    const chunks = stagedChunks(requireStore(options), record.where, await targetPrefix(ref, storageScope(record.where, record.key)), record, "STORAGE");

    if (size > STORAGE_UPLOAD_MAX_BODY_BYTES && options.storageMultipartUpload) {
        const { contentType, customMetadata } = record.upload;

        // No sha256 on the upload: R2 records none for a multipart object; the chunks are hashed as they stream.
        await uploadMultipart(await options.storageMultipartUpload(record.key, { ...record.where, contentType, customMetadata }), chunks, size);

        return;
    }

    const bytes = await collectChunks(chunks, size);

    await upload(record.key, bytes.buffer, record.upload);
};

const commitStorage = async (options: WorkerOptions, ref: SessionRef, records: AsyncIterable<StagedSectionRow>): Promise<SectionStepResult> => {
    const { storageDelete, storageList } = options;

    if (!storageDelete || !storageList) {
        throw new TypeError("storage replace is not configured");
    }

    const keep = new Set<string>();
    let inserted = 0;
    let deleted = 0;

    for await (const { doc } of records) {
        const record = parseStorageRecord(doc);

        if (!record) {
            throw new TypeError("a staged storage record does not parse");
        }

        keep.add(`${record.where.bucket ?? ""}\u0000${record.key}`);
        await writeObject(options, ref, record);
        inserted += 1;
    }

    for (const bucket of options.storageBuckets ?? [undefined]) {
        const doomed: string[] = [];

        // Lunora's own `_lunora/` objects are never listed here, so never deleted.
        // eslint-disable-next-line no-await-in-loop -- buckets one at a time
        for await (const object of storageObjects(storageList, bucket)) {
            if (!keep.has(`${bucket ?? ""}\u0000${object.key}`)) {
                doomed.push(object.key);
            }
        }

        // eslint-disable-next-line no-await-in-loop -- as above
        await Promise.all(doomed.map(async (key) => storageDelete(key, bucket === undefined ? {} : { bucket })));
        deleted += doomed.length;
    }

    // The staged chunks stay until the session is committed (`commitImport` drops
    // them then): if recording this step fails, a retried commit runs it again and
    // needs them to assemble the objects.
    return { deleted: { [STORAGE_TABLE]: deleted }, inserted: { [STORAGE_TABLE]: inserted } };
};

/** Run one section's commit step over its staged records. */
const commitSection = async (
    options: WorkerOptions,
    ref: SessionRef,
    section: ReplaceSection,
    records: AsyncIterable<StagedSectionRow>,
): Promise<SectionStepResult> => {
    switch (section) {
        case "auth": {
            return commitAuth(options, records);
        }
        case "kv": {
            return commitKv(options, ref, records);
        }
        default: {
            return commitStorage(options, ref, records);
        }
    }
};

/** The `$`-table a section's records are staged under. */
const SECTION_TABLE: Readonly<Record<ReplaceSection, string>> = { auth: AUTH_TABLE, kv: KV_TABLE, storage: STORAGE_TABLE };

export type { ReplaceSection, SectionStepResult, SessionRef, StagedSectionRow };
export { commitSection, dropStagedObjects, REPLACE_SECTIONS, SECTION_TABLE, sectionUnsupported, SESSION_STAGING_PREFIX, stageSectionRows };
