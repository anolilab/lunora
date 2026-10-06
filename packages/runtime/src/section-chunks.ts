/**
 * Restore staging for the chunked records of the export's `$kv` and `$storage`
 * sections (see `export-sections.ts`).
 *
 * A value or object too large for one line arrives as chunks that span several
 * import requests, so each chunk in front of the last is written to a staging
 * object as it lands, and the whole thing is assembled when the last one does:
 *
 * `_lunora/restore/<sha256 of the target>/<session>/<offset>`
 *
 * `<session>` is the time the target's first chunk arrived, counted down from
 * {@link SESSION_CLOCK_MAX} so the newest session of a target lists first: a
 * later chunk finds its session with one `list(limit: 1)`. A restore that
 * stops partway leaves its session behind; the next import sweeps every
 * session older than {@link STAGING_TTL_MS} when its header line lands.
 *
 * Every staged chunk is sealed with AES-GCM under a key derived from the
 * deployment's admin token, its own object key bound in as associated data. A
 * staging object sits in the app's bucket, which may be public, and a `$kv`
 * value is whatever the app keeps in KV — sessions, tokens — so what lands there
 * is ciphertext only, and a chunk cannot be moved to another position or target.
 * No admin token, no staging: a chunked record then fails as not configured.
 */
import type { R2MultipartUploadLike, R2UploadedPartLike } from "@lunora/platform";
import { sha256 } from "@noble/hashes/sha2.js";

import { fromBase64 } from "../../../shared/base64";
import type { StorageObject, WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import { toHex } from "./storage-admin-routes";

const RESTORE_STAGING_PREFIX = "_lunora/restore/";

/** How long a staging session may sit before the next import deletes it. */
const STAGING_TTL_MS: number = 24 * 60 * 60 * 1000;

/** 13 digits of milliseconds: good until the year 2286. */
const SESSION_CLOCK_MAX = 9_999_999_999_999;

/** `<sha256 hex>/<session>/`, the start of a staged chunk's key under the prefix. */
const SESSION_KEY = /^[\da-f]{64}\/(\d{13})\//u;

/** R2's multipart rules: every part but the last at least 5 MiB, all of them equal, at most 10 000. */
const MIN_PART_BYTES: number = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;

const LIST_PAGE_SIZE = 1000;

type Where = { bucket?: string };

/** The storage ops staging needs, all four, and the secret its chunks are sealed under. */
interface StagingStore {
    delete: NonNullable<WorkerOptions["storageDelete"]>;
    download: NonNullable<WorkerOptions["storageDownload"]>;
    list: NonNullable<WorkerOptions["storageList"]>;
    /** The admin token the sealing key is derived from. */
    secret: string;
    upload: NonNullable<WorkerOptions["storageUpload"]>;
}

const IV_BYTES = 12;

const sealingKeys = new Map<string, Promise<CryptoKey>>();

/** AES-256-GCM key for staged chunks, HKDF-SHA-256 over the admin token; one derivation per token per isolate. */
const sealingKey = async (secret: string): Promise<CryptoKey> => {
    let key = sealingKeys.get(secret);

    if (key === undefined) {
        key = (async () => {
            const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);

            return crypto.subtle.deriveKey(
                { hash: "SHA-256", info: new TextEncoder().encode("restore-staging"), name: "HKDF", salt: new TextEncoder().encode("lunora") },
                material,
                { length: 256, name: "AES-GCM" },
                false,
                ["encrypt", "decrypt"],
            );
        })();
        sealingKeys.set(secret, key);
    }

    return key;
};

/** `iv || ciphertext`, bound to `objectKey`. */
const seal = async (secret: string, objectKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> => {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt({ additionalData: new TextEncoder().encode(objectKey), iv, name: "AES-GCM" }, await sealingKey(secret), bytes);
    const out = new Uint8Array(IV_BYTES + sealed.byteLength);

    out.set(iv);
    out.set(new Uint8Array(sealed), IV_BYTES);

    return out.buffer;
};

/** The plaintext of a {@link seal}ed chunk, or `undefined` when it is not one sealed for `objectKey` under this secret. */
const unseal = async (secret: string, objectKey: string, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    if (sealed.byteLength <= IV_BYTES) {
        return undefined;
    }

    try {
        const plain = await crypto.subtle.decrypt(
            { additionalData: new TextEncoder().encode(objectKey), iv: sealed.subarray(0, IV_BYTES), name: "AES-GCM" },
            await sealingKey(secret),
            sealed.subarray(IV_BYTES),
        );

        return new Uint8Array(plain);
    } catch {
        return undefined;
    }
};

/** One validated chunk record: `data` decoded, plus what only the last chunk carries. */
interface ChunkRecord {
    bytes: Uint8Array<ArrayBuffer>;
    /** `size` of the whole value on the last chunk; `undefined` on the others. */
    lastSize: number | undefined;
    offset: number;
    /** Lowercase-hex SHA-256 of the whole value, on the last chunk when the export knew it. */
    sha256?: string;
}

const stagingStore = (options: WorkerOptions): StagingStore | undefined => {
    const { adminToken: secret, storageDelete, storageDownload, storageList, storageUpload } = options;

    return storageDelete && storageDownload && storageList && storageUpload && secret
        ? { delete: storageDelete, download: storageDownload, list: storageList, secret, upload: storageUpload }
        : undefined;
};

/** `{ offset, data, last?, size?, sha256? }`, or `undefined` when malformed. */
const parseChunk = (document: Record<string, unknown>): ChunkRecord | undefined => {
    const { data, last, offset, sha256: digest, size } = document;
    const validLast = last !== true || (typeof size === "number" && Number.isInteger(size) && size >= 0);

    if (typeof data !== "string" || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || !validLast) {
        return undefined;
    }

    return {
        bytes: fromBase64(data),
        lastSize: last === true ? (size as number) : undefined,
        offset,
        ...(typeof digest === "string" ? { sha256: digest } : {}),
    };
};

/** Every object under `prefix` in one bucket, following the listing's cursor. */
const listAll = async function* listAll(list: StagingStore["list"], prefix: string | undefined, where: Where): AsyncGenerator<StorageObject> {
    let cursor: string | undefined;
    let more = true;

    while (more) {
        // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's cursor
        const page = await list(prefix, { ...where, cursor, limit: LIST_PAGE_SIZE });

        yield* page.objects;
        cursor = page.cursor;
        more = cursor !== undefined && (page.truncated ?? true);
    }
};

/** Re-cut chunks into `size`-byte pieces; the final one may be shorter, and no input yields none. */
const fixedChunks = async function* fixedChunks(values: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    let buffer = new Uint8Array(size);
    let filled = 0;

    for await (const value of values) {
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

/** Where every session of one target lives: `scope` names the target (section, bucket or namespace, key). */
const stagingRoot = async (scope: string): Promise<string> =>
    `${RESTORE_STAGING_PREFIX}${toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope)))}/`;

const openSession = (root: string, now: number): string => `${root}${String(SESSION_CLOCK_MAX - now).padStart(13, "0")}/`;

/** The target's newest session, or `undefined` when none of its chunks were staged. */
const currentSession = async (store: StagingStore, root: string, where: Where): Promise<string | undefined> => {
    const { objects } = await store.list(root, { ...where, limit: 1 });
    const key = objects[0]?.key;
    const end = key?.startsWith(root) ? key.indexOf("/", root.length) : -1;

    return key === undefined || end === -1 ? undefined : key.slice(0, end + 1);
};

const chunkKey = (session: string, offset: number): string => `${session}${String(offset).padStart(16, "0")}`;

/**
 * Stage one chunk in front of the last. The first chunk opens a new session; a
 * later one joins the newest. `false` when a later chunk finds no session to join.
 */
const stageChunk = async (store: StagingStore, root: string, where: Where, chunk: ChunkRecord): Promise<boolean> => {
    const session = chunk.offset === 0 ? openSession(root, Date.now()) : await currentSession(store, root, where);

    if (session === undefined) {
        return false;
    }

    const key = chunkKey(session, chunk.offset);

    await store.upload(key, await seal(store.secret, key, chunk.bytes), where);

    return true;
};

const deleteSession = async (store: StagingStore, session: string, where: Where): Promise<void> => {
    const keys: string[] = [];

    for await (const object of listAll(store.list, session, where)) {
        keys.push(object.key);
    }

    await Promise.all(keys.map(async (key) => store.delete(key, where)));
};

/**
 * The staged chunks of a session in order, then the last chunk. Throws the
 * kind's RESTORE_INCOMPLETE code on a gap, and its SHA256_MISMATCH code after
 * the last chunk when the bytes do not hash to the export's digest. Holds one chunk.
 */
const stagedChunks = async function* stagedChunks(
    store: StagingStore,
    where: Where,
    session: string,
    last: ChunkRecord,
    kind: "KV" | "STORAGE",
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const incomplete = (message: string): LunoraError => new LunoraError(message, { code: `${kind}_RESTORE_INCOMPLETE` });
    const hash = sha256.create();
    let position = 0;

    if (last.offset + last.bytes.byteLength !== last.lastSize) {
        throw incomplete(`chunks add up to ${String(last.offset + last.bytes.byteLength)} of ${String(last.lastSize)} bytes`);
    }

    while (position < last.offset) {
        const key = chunkKey(session, position);
        // eslint-disable-next-line no-await-in-loop -- chunks are read back in order
        const part = await store.download(key, where);

        if (!part?.body) {
            throw incomplete(`the chunk at byte ${String(position)} never arrived`);
        }

        // eslint-disable-next-line no-await-in-loop -- chunks are read back in order
        const bytes = await unseal(store.secret, key, new Uint8Array(await new Response(part.body).arrayBuffer()));

        if (bytes === undefined) {
            throw incomplete(`the chunk at byte ${String(position)} was not staged by this deployment`);
        }

        if (bytes.byteLength === 0 || position + bytes.byteLength > last.offset) {
            throw incomplete(`the chunk at byte ${String(position)} overlaps the last chunk`);
        }

        hash.update(bytes);
        yield bytes;
        position += bytes.byteLength;
    }

    hash.update(last.bytes);
    yield last.bytes;

    if (last.sha256 !== undefined && toHex(hash.digest()) !== last.sha256.toLowerCase()) {
        throw new LunoraError(`the restored bytes do not match the exported sha256 ${last.sha256}`, { code: `${kind}_SHA256_MISMATCH` });
    }
};

/** Read a session back into one buffer of `size` bytes (the chunk iterator guarantees the sum). */
const collectChunks = async (chunks: AsyncIterable<Uint8Array>, size: number): Promise<Uint8Array<ArrayBuffer>> => {
    const buffer = new Uint8Array(size);
    let position = 0;

    for await (const chunk of chunks) {
        buffer.set(chunk, position);
        position += chunk.byteLength;
    }

    return buffer;
};

/**
 * Write `chunks` through a multipart upload, regrouped into equal parts of at
 * least 5 MiB (larger when the object would need over 10 000), holding one part.
 * Any failure — a digest mismatch included — aborts the upload, so no object appears.
 */
const uploadMultipart = async (multipart: R2MultipartUploadLike, chunks: AsyncIterable<Uint8Array>, size: number): Promise<void> => {
    const parts: R2UploadedPartLike[] = [];

    try {
        for await (const part of fixedChunks(chunks, Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS)))) {
            parts.push(await multipart.uploadPart(parts.length + 1, part));
        }

        await multipart.complete(parts);
    } catch (error) {
        // The original failure is what the import reports; a failed abort leaves
        // only uploaded parts, which R2 expires on its own.
        await multipart.abort().catch(() => {});

        throw error;
    }
};

/** A session's start time, or `undefined` for a key that is not `<root>/<session>/<offset>`. */
const sessionStartedAt = (key: string): number | undefined => {
    const match = SESSION_KEY.exec(key.slice(RESTORE_STAGING_PREFIX.length));

    return match?.[1] === undefined ? undefined : SESSION_CLOCK_MAX - Number(match[1]);
};

/**
 * Delete staged chunks whose session started over {@link STAGING_TTL_MS} ago,
 * in every bucket, along with anything else under the staging prefix that is
 * not a session (an earlier layout's leftovers). Nothing outside
 * `_lunora/restore/` is listed. Returns how many objects went.
 */
const sweepStaleStaging = async (store: StagingStore, buckets: ReadonlyArray<string | undefined>, now: number): Promise<number> => {
    let swept = 0;

    for (const bucket of buckets) {
        const where = bucket === undefined ? {} : { bucket };
        const stale: string[] = [];

        // eslint-disable-next-line no-await-in-loop -- buckets one at a time
        for await (const { key } of listAll(store.list, RESTORE_STAGING_PREFIX, where)) {
            const startedAt = sessionStartedAt(key);

            if (key.startsWith(RESTORE_STAGING_PREFIX) && (startedAt === undefined || now - startedAt > STAGING_TTL_MS)) {
                stale.push(key);
            }
        }

        // eslint-disable-next-line no-await-in-loop -- buckets one at a time
        await Promise.all(stale.map(async (key) => store.delete(key, where)));
        swept += stale.length;
    }

    return swept;
};

export type { ChunkRecord, StagingStore };
export {
    chunkKey,
    collectChunks,
    currentSession,
    deleteSession,
    fixedChunks,
    listAll,
    parseChunk,
    RESTORE_STAGING_PREFIX,
    seal,
    stageChunk,
    stagedChunks,
    stagingRoot,
    stagingStore,
    sweepStaleStaging,
    uploadMultipart,
};
