/**
 * Turns one request's chunks into R2 multipart parts of exactly
 * `R2_PART_SIZE` bytes. Bytes that do not fill a part wait in the bucket as
 * "segment" objects until a later request completes the part.
 */
import type { R2MultipartUploadLike, R2UploadedPartLike } from "@lunora/platform";
import { ERRORS, throwErrorCode } from "@visulima/storage";

import { ByteQueue } from "./byte-queue";
import type { FileRecord, R2UploadBucket, Segment, UploadProgress } from "./r2-upload-types";

/** Every part of an R2 multipart upload but the last is exactly this size: R2's 5 MiB minimum. */
const R2_PART_SIZE: number = 5 * 1024 * 1024;

/**
 * At most this many segments wait at once. Past it, the waiting bytes (always
 * under one part) are joined into a single segment, so a client sending tiny
 * chunks cannot pile up objects, or reads at the next part, without bound.
 */
const MAX_SEGMENTS = 8;

const sumSizes = (segments: Segment[]): number => segments.reduce((total, segment) => total + segment.size, 0);

/** What the writer asks of the request holding the upload's lease. */
interface PartWriterLease {
    /** Throws when the lease is lost. Called before every part is stored and before the object is made. */
    confirm: () => Promise<void>;
    /** Records the progress after a part is stored, under the lease. */
    save: (progress: UploadProgress, stored: number) => Promise<void>;
    /** Unique per request; keeps segment keys from colliding. */
    token: string;
}

class R2UploadPartWriter {
    public parts: R2UploadedPartLike[];

    public segments: Segment[];

    public uploadId: string | undefined;

    private readonly bucket: R2UploadBucket;

    /** Segment keys joined into stored bytes: deleted once the saved state no longer lists them. */
    private consumed: string[] = [];

    private readonly file: FileRecord;

    private readonly lease: PartWriterLease;

    private readonly pending = new ByteQueue();

    private readonly segmentPrefix: string;

    public constructor(bucket: R2UploadBucket, file: FileRecord, progress: UploadProgress, segmentPrefix: string, lease: PartWriterLease) {
        this.bucket = bucket;
        this.file = file;
        this.parts = [...progress.parts];
        this.segments = [...progress.segments];
        this.uploadId = progress.uploadId;
        this.segmentPrefix = segmentPrefix;
        this.lease = lease;
    }

    /** Bytes durably stored: the parts plus the segments. */
    public get stored(): number {
        return this.parts.length * R2_PART_SIZE + sumSizes(this.segments);
    }

    /** Bytes received so far, stored or not. */
    public get offset(): number {
        return this.stored + this.pending.size;
    }

    /** The progress to record (without a lock). */
    public progress(): UploadProgress {
        return { parts: [...this.parts], segments: [...this.segments], ...(this.uploadId === undefined ? {} : { uploadId: this.uploadId }) };
    }

    public async push(chunk: Uint8Array): Promise<void> {
        this.pending.push(chunk);

        while (sumSizes(this.segments) + this.pending.size >= R2_PART_SIZE) {
            // eslint-disable-next-line no-await-in-loop -- parts are stored in order
            await this.flushPart();
        }
    }

    /**
     * Store the bytes that did not fill a part as a new segment, so the next
     * request can pick them up. Past {@link MAX_SEGMENTS}, every waiting byte is
     * joined into one segment instead.
     */
    public async keepTail(): Promise<void> {
        if (this.pending.size === 0) {
            return;
        }

        const joinAll = this.segments.length + 1 > MAX_SEGMENTS;
        const start = joinAll ? this.parts.length * R2_PART_SIZE : this.stored;
        const size = joinAll ? sumSizes(this.segments) + this.pending.size : this.pending.size;
        const bytes = joinAll ? await this.assemble(size) : this.front(size);
        const key = `${this.segmentPrefix}${String(start).padStart(16, "0")}-${this.lease.token}`;

        await this.bucket.put(key, bytes);

        if (joinAll) {
            this.consumeSegments();
        }

        this.segments = [...this.segments, { key, size }];
        this.pending.drop(this.pending.size);
    }

    /**
     * Write the last bytes and make the object: a single `put` when no part was
     * ever stored, else the short last part and `complete()`. Answers the
     * object's etag.
     */
    public async finish(): Promise<string> {
        const tail = await this.assemble(sumSizes(this.segments) + this.pending.size);

        await this.lease.confirm();

        let etag: string;

        if (this.uploadId === undefined) {
            const object = await this.bucket.put(this.file.name, tail, { httpMetadata: { contentType: this.file.contentType } });

            etag = object.etag;
        } else {
            const upload = this.multipart(this.uploadId);

            if (tail.byteLength > 0) {
                const partNumber = this.parts.length + 1;
                const uploaded = await upload.uploadPart(partNumber, tail);

                this.parts.push({ etag: uploaded.etag, partNumber });
            }

            const object = await upload.complete(this.parts);

            etag = object.etag;
        }

        this.consumeSegments();
        this.pending.drop(this.pending.size);

        return etag;
    }

    /** Delete the segments the saved state no longer lists. Best effort: a leftover is cleaned up with the upload. */
    public async dropConsumed(): Promise<void> {
        const keys = this.consumed;

        this.consumed = [];

        if (keys.length > 0) {
            await this.bucket.delete(keys).catch(() => undefined);
        }
    }

    /** The first `size` waiting bytes (segments, then `pending`), without consuming them. */
    private async assemble(size: number): Promise<Uint8Array> {
        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const segment of this.segments) {
            // eslint-disable-next-line no-await-in-loop -- segments are joined in order
            const object = await this.bucket.get(segment.key);

            if (object === null) {
                return throwErrorCode(ERRORS.STORAGE_ERROR, `Buffered upload segment ${segment.key} is missing`);
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const body = new Uint8Array(await object.arrayBuffer());

            bytes.set(body, offset);
            offset += body.byteLength;
        }

        this.pending.copyFront(bytes, offset, size - offset);

        return bytes;
    }

    /** The first `size` bytes of `pending` alone. */
    private front(size: number): Uint8Array {
        const bytes = new Uint8Array(size);

        this.pending.copyFront(bytes, 0, size);

        return bytes;
    }

    private consumeSegments(): void {
        this.consumed.push(...this.segments.map((segment) => segment.key));
        this.segments = [];
    }

    private multipart(uploadId: string): R2MultipartUploadLike {
        return this.bucket.resumeMultipartUpload(this.file.name, uploadId);
    }

    /**
     * Join the waiting segments and the front of `pending` into one part, then
     * record it. `pending` is drained only once the part is stored, so a failure
     * leaves nothing half-consumed; a request killed later loses at most the
     * part it was working on.
     */
    private async flushPart(): Promise<void> {
        const fromSegments = sumSizes(this.segments);
        const part = await this.assemble(R2_PART_SIZE);

        await this.lease.confirm();

        if (this.uploadId === undefined) {
            const created = await this.bucket.createMultipartUpload(this.file.name, { httpMetadata: { contentType: this.file.contentType } });

            this.uploadId = created.uploadId;
        }

        const partNumber = this.parts.length + 1;
        const uploaded = await this.multipart(this.uploadId).uploadPart(partNumber, part);

        this.parts.push({ etag: uploaded.etag, partNumber });
        this.pending.drop(R2_PART_SIZE - fromSegments);
        this.consumeSegments();

        await this.lease.save(this.progress(), this.stored);
        await this.dropConsumed();
    }
}

export type { PartWriterLease };
export { R2_PART_SIZE, R2UploadPartWriter };
