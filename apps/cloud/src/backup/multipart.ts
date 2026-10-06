/**
 * Streaming a backup into object storage as a multipart upload, so its size is
 * bounded by the store rather than by the Worker's memory.
 *
 * A gzip stream has no length up front, and R2's single `put` refuses a stream
 * of unknown length — which is why tenant snapshots used to be assembled in
 * memory. A multipart upload takes fixed-size parts instead, so at most one
 * part is held at a time. The same shape serves the R2 binding
 * (`createMultipartUpload` matches it as is) and the S3 API of an off-site
 * account (`./offsite.ts`).
 */

/** One stored part, as the store answers it and `complete` takes it back. */
export interface UploadedPart {
    etag: string;
    partNumber: number;
}

/** An upload in progress — the subset of `R2MultipartUpload` this uses. */
export interface MultipartUpload {
    abort: () => Promise<void>;
    complete: (parts: UploadedPart[]) => Promise<unknown>;
    uploadPart: (partNumber: number, value: Uint8Array<ArrayBuffer>) => Promise<UploadedPart>;
}

/** A store that can start one — the subset of an R2 bucket binding this uses. */
export interface MultipartBucket {
    createMultipartUpload: (key: string, options?: { httpMetadata?: { contentType?: string } }) => Promise<MultipartUpload>;
}

/**
 * Bytes per part. R2 (like S3) wants every part but the last at least 5 MiB and
 * all of them the same size; 8 MiB keeps a 10 000-part upload past 78 GiB while
 * holding one part in memory.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/**
 * Upload `stream` to `key`, one {@link PART_BYTES} part at a time, and return
 * the bytes stored. Nothing becomes visible unless the whole stream arrived: a
 * stream that errors midway, or a part the store refuses, aborts the upload and
 * rejects.
 */
export const uploadStream = async (bucket: MultipartBucket, key: string, stream: ReadableStream<Uint8Array>, contentType: string): Promise<number> => {
    const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
    const reader = stream.getReader();
    const parts: UploadedPart[] = [];
    let part = new Uint8Array(PART_BYTES);
    let filled = 0;
    let total = 0;

    const flush = async (value: Uint8Array<ArrayBuffer>): Promise<void> => {
        parts.push(await upload.uploadPart(parts.length + 1, value));
        part = new Uint8Array(PART_BYTES);
        filled = 0;
    };

    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- a stream is read sequentially by construction
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            total += value.byteLength;

            let offset = 0;

            while (offset < value.byteLength) {
                const take = Math.min(PART_BYTES - filled, value.byteLength - offset);

                part.set(value.subarray(offset, offset + take), filled);
                filled += take;
                offset += take;

                if (filled === PART_BYTES) {
                    // eslint-disable-next-line no-await-in-loop -- parts go out in order, one held at a time
                    await flush(part);
                }
            }
        }

        // The last part may be short; an empty stream still needs one part to complete.
        if (filled > 0 || parts.length === 0) {
            await flush(part.slice(0, filled));
        }

        await upload.complete(parts);

        return total;
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        await upload.abort().catch(() => undefined);

        throw error;
    }
};

/** How an off-site copy went. `error` is bounded and carries a status, never object bytes or a credential. */
export interface CopyOutcome {
    error?: string;
    status: "failed" | "succeeded";
}

const MAX_COPY_ERROR_LENGTH = 300;

/**
 * Copy `key` from `source` into `target` under the same key, streamed through
 * {@link uploadStream}. Never throws: the copy is a second line of defence, so
 * its failure is an outcome to record, not a reason to fail the backup it copies.
 */
export const copyObject = async (
    source: { get: (key: string) => Promise<null | { body: ReadableStream<Uint8Array> }> },
    target: MultipartBucket,
    key: string,
    contentType: string,
): Promise<CopyOutcome> => {
    try {
        const object = await source.get(key);

        if (!object) {
            throw new Error("the primary object is missing");
        }

        await uploadStream(target, key, object.body, contentType);

        return { status: "succeeded" };
    } catch (error) {
        return { error: (error instanceof Error ? error.message : "off-site copy failed").slice(0, MAX_COPY_ERROR_LENGTH), status: "failed" };
    }
};
