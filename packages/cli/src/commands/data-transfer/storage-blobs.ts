/**
 * The `_storage` half of a Convex migration: reading the export's blob metadata,
 * and moving every blob into R2 through the worker's admin routes.
 */
import { LunoraError } from "@lunora/errors";
import { STORAGE_UPLOAD_MAX_BODY_BYTES } from "@lunora/runtime";

import { collectPages } from "../../../../../shared/collect-pages";
import type { Logger } from "../../util/logger";
import type { ConvexSnapshot, ConvexSnapshotTable } from "../convex-snapshot";
import { readSnapshotLines, readSnapshotStorageBlob } from "../convex-snapshot";
import type { StreamingFetchLike } from "./shared";
import { STORAGE_ENDPOINT_PATH, STORAGE_URL_ENDPOINT_PATH } from "./shared";

/** Blob uploads in flight at once. Enough to hide round-trip latency, few enough to stay polite. */
const BLOB_UPLOAD_CONCURRENCY = 8;

/**
 * Bytes allowed in flight across the whole upload window.
 *
 * A count alone multiplies against the per-blob ceiling: eight concurrent 32 MiB
 * uploads is ~256 MiB of request bodies, and the worker holds roughly twice each
 * body while it buffers and digests — against a 128 MB isolate limit shared by
 * every concurrent request. Budgeting bytes as well as requests means a window
 * of small blobs still runs eight wide, while large ones narrow it automatically.
 */
const BLOB_UPLOAD_MAX_INFLIGHT_BYTES = 24 * 1_048_576;

/** Page size for the admin object listing — the route's own default is 100, which is a lot of round trips over a large bucket. */
const STORAGE_LIST_PAGE_SIZE = 1000;

/** One validated `_storage/documents.jsonl` row: the blob's id, digest, and byte length. */
interface StorageMetadataRow {
    contentType?: string;
    id: string;
    /** Lowercase hex, whatever encoding the export used. */
    sha256: string;
    size: number;
}

const HEX_SHA256_RE = /^[\dA-F]{64}$/i;

/**
 * Can this string legally sit in an HTTP header value?
 *
 * Checked by code point rather than a regex literal: a CR/LF here otherwise
 * reaches the HTTP client, which rejects it with an opaque "Invalid header
 * value" instead of naming the offending metadata line the way every other
 * field does.
 */
const isHeaderSafe = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.codePointAt(index) ?? 0;

        if (code < 0x20 || code === 0x7f) {
            return false;
        }
    }

    return true;
};
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

    // `contentType` is the only metadata field that becomes a request header, so
    // a CR/LF in it crashes the HTTP client with an opaque "Invalid header
    // value" instead of naming the offending line the way every other field
    // does.
    if (storageDocument.contentType !== undefined && (typeof storageDocument.contentType !== "string" || !isHeaderSafe(storageDocument.contentType))) {
        throw new LunoraError("INTERNAL", `${where}: \`contentType\` must be a string with no control characters`);
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
        let lineNumber = 0;

        for await (const line of readSnapshotLines(snapshot, storageTableEntry)) {
            const trimmed = line.trim();

            lineNumber += 1;

            if (trimmed.length > 0) {
                rows.push(parseStorageMetadataRow(trimmed, `_storage/documents.jsonl line ${String(lineNumber)}`));
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
 * Body budget of `PUT /_lunora/admin/storage` — imported from the route that
 * enforces it, not restated, because the two drifting apart decides whether an
 * upload silently takes the unverified path. Blobs up to this size take the
 * verified route, which digests the body and refuses to write on a mismatch.
 * Above it the admin route refuses the body, so the signed-PUT fallback applies
 * — see `uploadLargeBlob` for what that path can and cannot promise.
 */
const MAX_VERIFIED_UPLOAD_BYTES: number = STORAGE_UPLOAD_MAX_BODY_BYTES;

/** One object as `GET /_lunora/admin/storage` reports it. */
interface StorageListObject {
    key: string;
    sha256?: string;
    size?: number;
}

interface BlobUploadContext {
    baseUrl: string;
    /** Named bucket for a multi-bucket deployment; omit for the worker's default bucket. */
    bucket?: string;
    fetchImpl: StreamingFetchLike;
    token: string;
}

/** `&bucket=` when a named bucket was selected, nothing when the default is meant. */
const bucketQuery = (context: BlobUploadContext): string => (context.bucket === undefined ? "" : `&bucket=${encodeURIComponent(context.bucket)}`);

/** List the objects under `prefix`, following the cursor to the end. */
const listStorageObjects = async (context: BlobUploadContext, prefix: string): Promise<StorageListObject[]> =>
    await collectPages<StorageListObject>(async (cursor) => {
        // An explicit page size matters here: the host's own default is 100, and
        // the idempotency pre-flight walks the whole key prefix.
        const url = `${context.baseUrl}${STORAGE_ENDPOINT_PATH}?prefix=${encodeURIComponent(prefix)}&limit=${String(STORAGE_LIST_PAGE_SIZE)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}${bucketQuery(context)}`;

        const response = await context.fetchImpl(url, { headers: { authorization: `Bearer ${context.token}` }, method: "GET" });

        if (!response.ok) {
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `storage list failed (HTTP ${String(response.status)}): ${text}`);
        }

        const json = (await response.json()) as { cursor?: string; objects?: StorageListObject[]; truncated?: boolean };

        // `collectPages` names the row array `records`; the storage route names
        // it `objects`. Same page shape otherwise, including the non-advancing
        // cursor the walker refuses to follow forever.
        return { cursor: json.cursor, records: json.objects, truncated: json.truncated };
    });

/**
 * Upload one blob through the checksum-verified admin route. The worker digests
 * the body and returns the computed hash, so a corrupt transfer is rejected
 * before anything is written.
 */
const uploadSmallBlob = async (context: BlobUploadContext, key: string, blobBytes: Buffer, metadata: StorageMetadataRow): Promise<string> => {
    const url = `${context.baseUrl}${STORAGE_ENDPOINT_PATH}?key=${encodeURIComponent(key)}&expectedSha256=${metadata.sha256}&expectedSize=${String(metadata.size)}${bucketQuery(context)}`;

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

/**
 * Remove an object that failed post-upload verification, reporting whether it
 * actually went. The idempotency rule treats a present object at a content-hash
 * key as already-migrated, so a delete that quietly failed would leave a bad
 * blob that every later run skips — the caller has to be able to say which
 * happened.
 */
const deleteStorageObject = async (context: BlobUploadContext, key: string): Promise<boolean> => {
    const response = await context
        .fetchImpl(`${context.baseUrl}${STORAGE_ENDPOINT_PATH}?key=${encodeURIComponent(key)}${bucketQuery(context)}`, {
            headers: { authorization: `Bearer ${context.token}` },
            method: "DELETE",
        })
        .catch(() => undefined);

    return response?.ok === true;
};

/**
 * Upload a blob too large for the worker's body cap through a signed `PUT` URL,
 * then verify what landed by listing it back.
 *
 * The signed URL is worker-signed (`@lunora/storage`'s `getSignedUrl`), so the
 * bytes still flow through an app-served route rather than straight to R2 — and
 * that route gets the runtime's shared 1 MiB body cap unless the app raises it.
 * The pre-write digest check is not available here either way, because the
 * worker never sees this request as an admin upload. R2 only records a SHA-256 checksum when the writer supplied one, so the
 * list may legitimately omit `sha256`; size is always comparable. When the
 * object that landed does not match, it is DELETED before the failure
 * propagates — otherwise the bad object would sit at a content-hash key and a
 * later re-run would treat it as already-migrated.
 */
const uploadLargeBlob = async (context: BlobUploadContext, key: string, blobBytes: Buffer, metadata: StorageMetadataRow, logger: Logger): Promise<string> => {
    const mintUrl = `${context.baseUrl}${STORAGE_URL_ENDPOINT_PATH}?key=${encodeURIComponent(key)}&method=PUT&contentType=${encodeURIComponent(metadata.contentType ?? "application/octet-stream")}${bucketQuery(context)}`;

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

    // Both fields are optional on the listing, and an absent one means "the host
    // does not report this", not "it does not match". Treating a missing value as
    // a mismatch would delete the object that was just uploaded correctly.
    const sizeMismatch = stored.size !== undefined && stored.size !== metadata.size;
    const hashMismatch = stored.sha256 !== undefined && stored.sha256.toLowerCase() !== metadata.sha256;

    if (sizeMismatch || hashMismatch) {
        const removed = await deleteStorageObject(context, key);

        throw new LunoraError(
            "INTERNAL",
            `post-upload verification failed: expected sha256=${metadata.sha256} size=${String(metadata.size)}, got sha256=${stored.sha256 ?? "none"} size=${String(stored.size ?? "none")}${removed ? " (the object was removed)" : ` — AND the object could not be removed: delete ${key} by hand before re-running, or the next run will treat it as already migrated`}`,
        );
    }

    const unchecked = [stored.size === undefined ? "size" : undefined, stored.sha256 === undefined ? "sha256" : undefined].filter(Boolean);

    if (unchecked.length > 0) {
        logger.warn(
            `blob ${key} went through the signed-PUT path and the host reports no ${unchecked.join(" or ")} for it — that much of the write is unverified`,
        );
    }

    return key;
};

/**
 * Upload one object with its declared size + checksum, through the verified
 * admin route when it fits that route's body cap and the signed-PUT fallback
 * when it does not. The caller names the `key`: a blob migration uses the
 * content hash (so a re-run is idempotent), a backup uses its snapshot name.
 */
const uploadStorageBlob = async (context: BlobUploadContext, key: string, blobBytes: Buffer, metadata: StorageMetadataRow, logger: Logger): Promise<string> => {
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
 * Split the pending blobs into windows bounded by BOTH a request count and a
 * byte budget.
 *
 * The first blob of a window always goes in, even if it alone exceeds the byte
 * budget — one upload has to be allowed to proceed, or a single large blob would
 * stall the run forever.
 */
const uploadWindows = (pending: ReadonlyArray<StorageMetadataRow>): StorageMetadataRow[][] => {
    const windows: StorageMetadataRow[][] = [];
    let current: StorageMetadataRow[] = [];
    let bytes = 0;

    for (const row of pending) {
        if (current.length > 0 && (current.length >= BLOB_UPLOAD_CONCURRENCY || bytes + row.size > BLOB_UPLOAD_MAX_INFLIGHT_BYTES)) {
            windows.push(current);
            current = [];
            bytes = 0;
        }

        current.push(row);
        bytes += row.size;
    }

    if (current.length > 0) {
        windows.push(current);
    }

    return windows;
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
    const pending: StorageMetadataRow[] = [];

    for (const row of metadataRows) {
        const key = `${keyPrefix}${row.sha256}`;

        if (existing.get(key)?.size === row.size) {
            storageIdMap.set(row.id, key);
        } else {
            pending.push(row);
        }
    }

    logger.info(`migrating ${String(pending.length)} storage blobs${storageIdMap.size > 0 ? ` (${String(storageIdMap.size)} already present)` : ""}...`);

    const uploadOne = async (row: StorageMetadataRow): Promise<void> => {
        try {
            const blobBytes = await readSnapshotStorageBlob(snapshot, row.id);

            storageIdMap.set(row.id, await uploadStorageBlob(context, `${keyPrefix}${row.sha256}`, blobBytes, row, logger));
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            logger.error(`failed to upload blob ${row.id}: ${message}`);

            throw error;
        }
    };

    // Blobs are independent — each carries its own key and its own verification,
    // so nothing orders them. Serially, a 50k-blob migration is round-trip-bound
    // for hours. A window keeps that bounded without letting an export open
    // 50k sockets. `allSettled` per window preserves fail-close: no request
    // outlives the failure, and the first error is the one reported.
    for (const window of uploadWindows(pending)) {
        // eslint-disable-next-line no-await-in-loop -- one window at a time is the point of the window
        const settled = await Promise.allSettled(window.map((row) => uploadOne(row)));
        const failure = settled.find((outcome) => outcome.status === "rejected");

        if (failure !== undefined) {
            throw failure.reason;
        }
    }

    logger.success(`migrated ${String(pending.length)} storage blobs`);

    return storageIdMap;
};

export type { BlobUploadContext, StorageMetadataRow };
export { bucketQuery, listStorageObjects, MAX_VERIFIED_UPLOAD_BYTES, migrateStorageBlobs, normalizeSha256, readStorageMetadata, uploadStorageBlob };
