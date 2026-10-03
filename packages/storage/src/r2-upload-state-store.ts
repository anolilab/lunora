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

        const body = await object.arrayBuffer();

        return { etag: object.etag, state: JSON.parse(new TextDecoder().decode(body)) as UploadState };
    }

    /**
     * Write `state`. With an `etag`, only if the stored object still carries it.
     * Returns the new etag, or `undefined` when the condition failed.
     */
    public async write(id: string, state: UploadState, etag?: string): Promise<string | undefined> {
        const stored = await this.bucket.put(this.getMetaName(id), JSON.stringify(state), etag === undefined ? undefined : { onlyIf: { etagMatches: etag } });

        return stored?.etag;
    }

    /**
     * Compare-and-swap loop: read, `change`, write on the etag read. `change`
     * may throw to give up (a lost lease, say).
     */
    public async swap(id: string, change: (state: UploadState) => UploadState): Promise<UploadState> {
        for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each attempt re-reads what the previous one lost to
            const stored = await this.read(id);

            if (stored === undefined) {
                return throwErrorCode(ERRORS.FILE_NOT_FOUND);
            }

            const next = change(stored.state);

            // eslint-disable-next-line no-await-in-loop -- see above
            const etag = await this.write(id, next, stored.etag);

            if (etag !== undefined) {
                return next;
            }
        }

        return throwErrorCode(ERRORS.FILE_CONFLICT, "The upload kept changing while it was being written; resume from the current offset");
    }

    public override async get(id: string): Promise<File> {
        const stored = await this.read(id);

        if (stored === undefined) {
            throw new Error(`Upload state not found for id: ${id}`);
        }

        return stored.state.file;
    }

    /** Replace the public file record, keeping the upload's progress. */
    public override async save(id: string, file: File): Promise<File> {
        const record: FileRecord = file;

        await this.swap(id, (state) => {
            return { ...state, file: { ...record } };
        });

        return file;
    }

    public override async touch(id: string, file: File): Promise<File> {
        return this.save(id, file);
    }

    public override async delete(id: string): Promise<void> {
        await this.bucket.delete(this.getMetaName(id));
    }
}

export type { StoredState };
export { R2UploadStateStore };
