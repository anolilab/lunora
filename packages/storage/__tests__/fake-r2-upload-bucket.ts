/**
 * A minimal in-memory R2 binding for the binding-backed upload provider: the
 * calls `R2UploadBucket` declares, with the R2 rules that matter to it —
 * conditional puts (`onlyIf.etagMatches` answers `null` on a mismatch; etags
 * are content hashes, as R2's are), and a multipart `complete` that refuses
 * parts under 5 MiB or of unequal size (every part but the last), as R2 does.
 */
import { createHash } from "node:crypto";

import type { R2UploadBucket, R2UploadBucketMultipartUpload } from "../src/r2-binding-upload-storage";

const MIN_PART = 5 * 1024 * 1024;

interface StoredObject {
    bytes: Uint8Array;
    contentType?: string;
    etag: string;
    uploaded: Date;
}

interface OpenUpload {
    contentType?: string;
    key: string;
    parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const copyBytes = (value: ArrayBuffer | ArrayBufferView | string): Uint8Array => {
    if (typeof value === "string") {
        return new TextEncoder().encode(value);
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
};

const createFakeR2UploadBucket = (): R2UploadBucket & {
    objects: Map<string, StoredObject>;
    openUploads: Map<string, OpenUpload>;
    partSizes: number[][];
} => {
    const objects = new Map<string, StoredObject>();
    const openUploads = new Map<string, OpenUpload>();
    const partSizes: number[][] = [];
    let uploadCounter = 0;

    const store = (key: string, bytes: Uint8Array, contentType?: string): StoredObject => {
        const object: StoredObject = { bytes, contentType, etag: digest(bytes), uploaded: new Date() };

        objects.set(key, object);

        return object;
    };

    const multipart = (key: string, uploadId: string): R2UploadBucketMultipartUpload => {
        const open = (): OpenUpload => {
            const upload = openUploads.get(uploadId);

            if (upload?.key !== key) {
                throw new Error(`NoSuchUpload: ${uploadId}`);
            }

            return upload;
        };

        return {
            abort: async () => {
                open();
                openUploads.delete(uploadId);
            },
            complete: async (uploadedParts) => {
                const upload = open();
                const chunks: Uint8Array[] = [];

                uploadedParts.forEach(({ etag, partNumber }, index) => {
                    const part = upload.parts.get(partNumber);

                    if (part?.etag !== etag) {
                        throw new Error(`InvalidPart: ${String(partNumber)}`);
                    }

                    const isLast = index === uploadedParts.length - 1;

                    if (!isLast && part.bytes.byteLength < MIN_PART) {
                        throw new Error("EntityTooSmall: every part but the last must be at least 5 MiB");
                    }

                    if (!isLast && index > 0 && part.bytes.byteLength !== chunks[0]?.byteLength) {
                        throw new Error("InvalidPart: all non-trailing parts must have the same length");
                    }

                    chunks.push(part.bytes);
                });

                const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                const bytes = new Uint8Array(total);
                let offset = 0;

                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }

                partSizes.push(chunks.map((chunk) => chunk.byteLength));
                openUploads.delete(uploadId);

                return store(key, bytes, upload.contentType);
            },
            uploadId,
            uploadPart: async (partNumber, value) => {
                const bytes = copyBytes(value);
                const etag = digest(bytes);

                open().parts.set(partNumber, { bytes, etag });

                return { etag, partNumber };
            },
        };
    };

    return {
        createMultipartUpload: async (key, options) => {
            uploadCounter += 1;

            const uploadId = `upload-${String(uploadCounter)}`;

            openUploads.set(uploadId, { contentType: options?.httpMetadata?.contentType, key, parts: new Map() });

            return multipart(key, uploadId);
        },
        delete: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                objects.delete(key);
            }
        },
        get: async (key) => {
            const object = objects.get(key);

            if (object === undefined) {
                return null;
            }

            return { arrayBuffer: async () => new Uint8Array(object.bytes).buffer, etag: object.etag };
        },
        // Two keys per page, so the provider's pagination is exercised.
        list: async (options) => {
            const keys = [...objects.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).toSorted((left, right) => left.localeCompare(right));
            const start = options?.cursor === undefined ? 0 : Number(options.cursor);
            const page = keys.slice(start, start + 2);
            const truncated = start + 2 < keys.length;

            return {
                objects: page.map((key) => {
                    return { key, uploaded: objects.get(key)?.uploaded ?? new Date() };
                }),
                truncated,
                ...(truncated ? { cursor: String(start + 2) } : {}),
            };
        },
        objects,
        openUploads,
        partSizes,
        put: async (key, value, options) => {
            const etagMatches = options?.onlyIf?.etagMatches;

            if (etagMatches !== undefined && objects.get(key)?.etag !== etagMatches) {
                return null;
            }

            return store(key, copyBytes(value), options?.httpMetadata?.contentType);
        },
        resumeMultipartUpload: (key, uploadId) => multipart(key, uploadId),
    };
};

// eslint-disable-next-line import/prefer-default-export -- a named test helper
export { createFakeR2UploadBucket };
