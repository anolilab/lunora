/**
 * The per-upload state objects of the binding-backed upload provider: one JSON
 * object per upload in the bucket, written with conditional puts so two
 * isolates never both win a compare-and-swap.
 */
import type { File } from "@visulima/storage";
import { ERRORS, MetaStorage, throwErrorCode } from "@visulima/storage";

import type { FileRecord, R2UploadBucket, UploadState } from "./r2-upload-types";

/** Attempts at a compare-and-swap before giving up with a `409`. */
const CAS_ATTEMPTS = 5;

/**
 * Fields of the file record that track the upload's progress. Only the
 * provider writes them: a metadata `update()` never carries them into the
 * stored record.
 */
const PROVIDER_OWNED_FIELDS = ["bytesWritten", "ETag", "id", "name", "size", "status"] as const satisfies ReadonlyArray<keyof File>;

/** The metadata key the chunked-REST handler records its chunks under. */
const CHUNKS_KEY = "_chunks";

/** The metadata flag the chunked-REST create sets on an upload. */
const CHUNKED_UPLOAD_KEY = "_chunkedUpload";

/** A chunk the chunked-REST handler records: a byte range of the upload. */
interface ChunkRange {
    length: number;
    offset: number;
}

/** A range as upstream records one: a non-negative integer offset and a positive integer length. */
const isChunkRange = (value: unknown): value is ChunkRange => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const { length, offset } = value as Partial<Record<keyof ChunkRange, unknown>>;

    return Number.isSafeInteger(offset) && (offset as number) >= 0 && Number.isSafeInteger(length) && (length as number) > 0;
};

/**
 * A chunked-REST record with its chunk list (`_chunks`) merged into
 * contiguous ranges. Upstream appends one entry per chunk; this provider only
 * appends bytes, so the list is one prefix and is stored as one entry however
 * many chunks the upload takes, which keeps the state object small.
 */
const coalesceChunks = (file: FileRecord): FileRecord => {
    const chunks: unknown = file.metadata[CHUNKS_KEY];

    if (file.metadata[CHUNKED_UPLOAD_KEY] !== true || !Array.isArray(chunks) || !chunks.every((chunk) => isChunkRange(chunk))) {
        return file;
    }

    const merged: ChunkRange[] = [];

    const ranges: ChunkRange[] = chunks;

    for (const { length, offset } of ranges.toSorted((a, b) => a.offset - b.offset)) {
        const last = merged.at(-1);

        if (last !== undefined && offset <= last.offset + last.length) {
            last.length = Math.max(last.length, offset + length - last.offset);
        } else {
            merged.push({ length, offset });
        }
    }

    return { ...file, metadata: Object.fromEntries([...Object.entries(file.metadata), [CHUNKS_KEY, merged]]) };
};

/** Two records that differ at most in `modifiedAt`, which every `update()` bumps. */
const sameRecord = (a: FileRecord, b: FileRecord): boolean =>
    JSON.stringify({ ...a, modifiedAt: undefined }) === JSON.stringify({ ...b, modifiedAt: undefined });

interface StoredState {
    etag: string;
    state: UploadState;
}

class R2UploadStateStore extends MetaStorage {
    private readonly bucket: R2UploadBucket;

    public constructor(bucket: R2UploadBucket, statePrefix: string) {
        super({ prefix: statePrefix, suffix: ".json" });

        this.bucket = bucket;
    }

    /** Prefix of an upload's buffered segments. Never a prefix of another upload's keys. */
    public segmentPrefix(id: string): string {
        return `${this.prefix}${id}/`;
    }

    public async read(id: string): Promise<StoredState | undefined> {
        const object = await this.bucket.get(this.getMetaName(id));

        if (object === null) {
            return undefined;
        }

        const body = await object.text();

        return { etag: object.etag, state: JSON.parse(body) as UploadState };
    }

    /** Write a new upload's state, only if no state exists under its id yet. Answers whether it did. */
    public async create(id: string, state: UploadState): Promise<boolean> {
        const stored = await this.bucket.put(this.getMetaName(id), JSON.stringify(state), { onlyIf: { etagDoesNotMatch: "*" } });

        return stored !== null;
    }

    /** Write `state` only if the stored object still carries `etag`. Answers the new etag, or `undefined` when it lost. */
    public async write(id: string, state: UploadState, etag: string): Promise<string | undefined> {
        const stored = await this.bucket.put(this.getMetaName(id), JSON.stringify(state), { onlyIf: { etagMatches: etag } });

        return stored?.etag;
    }

    /**
     * Compare-and-swap loop: read, `change`, write on the etag read. `change`
     * may throw to give up (a lost lease, say), or answer the state it was
     * given to write nothing.
     */
    public async swap(id: string, change: (state: UploadState) => UploadState): Promise<UploadState> {
        for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each attempt re-reads what the previous one lost to
            const stored = await this.read(id);

            if (stored === undefined) {
                return throwErrorCode(ERRORS.FILE_NOT_FOUND);
            }

            const next = change(stored.state);

            if (next === stored.state) {
                return next;
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const etag = await this.write(id, next, stored.etag);

            if (etag !== undefined) {
                return next;
            }
        }

        return throwErrorCode(ERRORS.FILE_CONFLICT, "The upload kept changing while it was being written; resume from the current offset");
    }

    /** The public file record (what `getMeta` answers). */
    public override async get(id: string): Promise<File> {
        const stored = await this.read(id);

        if (stored === undefined) {
            throw new Error(`Upload state not found for id: ${id}`);
        }

        return stored.state.file;
    }

    /**
     * Kept because the base class's `update()` persists through it: it merges
     * the caller's changes the base way, then saves. This lays that record over
     * the current state under a compare-and-swap, keeping the progress fields
     * from the stored record, so a metadata update can never rewind an upload.
     * A record that differs in nothing but `modifiedAt` is not written.
     */
    public override async save(id: string, file: File): Promise<File> {
        const next = await this.swap(id, (state) => {
            const saved: FileRecord = file;
            const record: FileRecord = coalesceChunks({ ...saved });

            for (const field of PROVIDER_OWNED_FIELDS) {
                (record as Record<string, unknown>)[field] = state.file[field];
            }

            if (sameRecord(record, state.file)) {
                return state;
            }

            return { ...state, file: record };
        });

        return next.file;
    }

    public override async delete(id: string): Promise<void> {
        await this.bucket.delete(this.getMetaName(id));
    }
}

export type { StoredState };
export { PROVIDER_OWNED_FIELDS, R2UploadStateStore };
