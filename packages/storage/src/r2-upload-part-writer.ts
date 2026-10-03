/**
 * Turns one request's chunks into R2 multipart parts of exactly
 * `R2_PART_SIZE` bytes. Bytes that do not fill a part wait in the bucket
 * as "segment" objects until a later request completes the part.
 */
import { ERRORS, throwErrorCode } from "@visulima/storage";

import { ByteQueue } from "./byte-queue";
import type { FileRecord, R2UploadBucket, R2UploadBucketMultipartUpload, Segment, UploadedPart, UploadProgress } from "./r2-upload-types";

/** Every part of an R2 multipart upload but the last is exactly this size: R2's 5 MiB minimum. */
const R2_PART_SIZE: number = 5 * 1024 * 1024;

const sumSizes = (segments: Segment[]): number => segments.reduce((total, segment) => total + segment.size, 0);

class R2UploadPartWriter {
    /** Segment keys joined into a stored part: delete them once the new state no longer lists them. */
    public readonly consumed: string[] = [];

    public readonly parts: UploadedPart[];

    public segments: Segment[];

    public uploadId: string | undefined;

    private readonly bucket: R2UploadBucket;

    private readonly file: FileRecord;

    private readonly pending = new ByteQueue();

    private readonly segmentPrefix: string;

    public constructor(bucket: R2UploadBucket, file: FileRecord, progress: UploadProgress, segmentPrefix: string) {
        this.bucket = bucket;
        this.file = file;
        this.parts = [...progress.parts];
        this.segments = [...progress.segments];
        this.uploadId = progress.uploadId;
        this.segmentPrefix = segmentPrefix;
    }

    /** Bytes received so far, stored or not. */
    public get offset(): number {
        return this.parts.length * R2_PART_SIZE + sumSizes(this.segments) + this.pending.size;
    }

    /** Bytes durably stored: the parts plus the segments. */
    public get stored(): number {
        return this.parts.length * R2_PART_SIZE + sumSizes(this.segments);
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
     * request can pick them up. `token` keeps the key unique per request.
     */
    public async keepTail(token: string): Promise<void> {
        if (this.pending.size === 0) {
            return;
        }

        const start = this.stored;
        const key = `${this.segmentPrefix}${String(start).padStart(16, "0")}-${token}`;
        const { size } = this.pending;

        await this.bucket.put(key, this.pending.toBytes());
        this.segments = [...this.segments, { key, size }];
        this.pending.drop(size);
    }

    /**
     * Write the last bytes and make the object: a single `put` when no part was
     * ever stored, else the short last part and `complete()`. Returns the
     * object's etag.
     */
    public async finish(): Promise<string | undefined> {
        const tail = new Uint8Array(sumSizes(this.segments) + this.pending.size);
        const fromSegments = await this.readSegments(tail);

        this.pending.copyFront(tail, fromSegments, this.pending.size);

        let etag: string | undefined;

        if (this.uploadId === undefined) {
            const object = await this.bucket.put(this.file.name, tail, { httpMetadata: { contentType: this.file.contentType } });

            etag = object?.etag;
        } else {
            const upload = await this.multipart();

            if (tail.byteLength > 0) {
                const partNumber = this.parts.length + 1;
                const uploaded = await upload.uploadPart(partNumber, tail);

                this.parts.push({ etag: uploaded.etag, partNumber });
            }

            const object = await upload.complete(this.parts);

            etag = object.etag;
        }

        this.consumed.push(...this.segments.map((segment) => segment.key));
        this.segments = [];
        this.pending.drop(this.pending.size);

        return etag;
    }

    private async multipart(): Promise<R2UploadBucketMultipartUpload> {
        if (this.uploadId === undefined) {
            const created = await this.bucket.createMultipartUpload(this.file.name, { httpMetadata: { contentType: this.file.contentType } });

            this.uploadId = created.uploadId;
        }

        return this.bucket.resumeMultipartUpload(this.file.name, this.uploadId);
    }

    private async readSegments(target: Uint8Array): Promise<number> {
        let offset = 0;

        for (const segment of this.segments) {
            // eslint-disable-next-line no-await-in-loop -- segments are joined in order
            const object = await this.bucket.get(segment.key);

            if (object === null) {
                return throwErrorCode(ERRORS.STORAGE_ERROR, `Buffered upload segment ${segment.key} is missing`);
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const bytes = new Uint8Array(await object.arrayBuffer());

            target.set(bytes, offset);
            offset += bytes.byteLength;
        }

        return offset;
    }

    /**
     * Join the waiting segments and the front of `pending` into one part.
     * `pending` is drained only once the part is stored, so a failure leaves
     * nothing half-consumed.
     */
    private async flushPart(): Promise<void> {
        const part = new Uint8Array(R2_PART_SIZE);
        const fromSegments = await this.readSegments(part);
        const fromPending = R2_PART_SIZE - fromSegments;

        this.pending.copyFront(part, fromSegments, fromPending);

        const partNumber = this.parts.length + 1;
        const upload = await this.multipart();
        const uploaded = await upload.uploadPart(partNumber, part);

        this.parts.push({ etag: uploaded.etag, partNumber });
        this.pending.drop(fromPending);
        this.consumed.push(...this.segments.map((segment) => segment.key));
        this.segments = [];
    }
}

export { R2_PART_SIZE, R2UploadPartWriter };
