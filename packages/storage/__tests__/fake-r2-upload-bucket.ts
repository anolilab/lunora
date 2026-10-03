/**
 * A minimal in-memory R2 binding for the binding-backed upload provider, with
 * the R2 rules that matter to it: conditional puts (`onlyIf` answers `null`
 * when its precondition fails; etags are content hashes, as R2's are;
 * `etagDoesNotMatch: "*"` is create-only), a delimiter roll-up on `list`, and a
 * multipart `complete` that refuses parts under 5 MiB or of unequal size (every
 * part but the last), as R2 does.
 */
import { createHash } from "node:crypto";

import type { R2ConditionalLike, R2MultipartUploadLike, R2ObjectBodyLike, R2ObjectLike, R2PutBodyLike, R2PutOptionsLike } from "@lunora/platform";

import { toBytes } from "../src/byte-queue";
import type { R2UploadBucket } from "../src/r2-binding-upload-storage";

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

/** A private copy, so a caller reusing its buffer cannot change what was stored. */
const copyBytes = (value: unknown): Uint8Array => new Uint8Array(toBytes(value));

/** Key order as R2 lists it: by code unit, not by locale. */
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : 1);

const meets = (condition: R2ConditionalLike, etag: string | undefined): boolean => {
    const matches = (expected: string): boolean => etag !== undefined && (expected === "*" || expected === etag);

    if (condition.etagMatches !== undefined && !matches(condition.etagMatches)) {
        return false;
    }

    return condition.etagDoesNotMatch === undefined || !matches(condition.etagDoesNotMatch);
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

    const project = (key: string, object: StoredObject): R2ObjectLike => {
        return { etag: object.etag, httpMetadata: { contentType: object.contentType }, key, size: object.bytes.byteLength, uploaded: object.uploaded };
    };

    const store = (key: string, bytes: Uint8Array, contentType?: string): R2ObjectLike => {
        const object: StoredObject = { bytes, contentType, etag: digest(bytes), uploaded: new Date() };

        objects.set(key, object);

        return project(key, object);
    };

    const multipart = (key: string, uploadId: string): R2MultipartUploadLike => {
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

                const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
                let offset = 0;

                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }

                partSizes.push(chunks.map((chunk) => chunk.byteLength));
                openUploads.delete(uploadId);

                return store(key, bytes, upload.contentType);
            },
            key,
            uploadId,
            uploadPart: async (partNumber, value) => {
                const bytes = copyBytes(value);
                const etag = digest(bytes);

                open().parts.set(partNumber, { bytes, etag });

                return { etag, partNumber };
            },
        };
    };

    const put = async (key: string, value: R2PutBodyLike, options?: R2PutOptionsLike & { onlyIf?: R2ConditionalLike }): Promise<R2ObjectLike | null> => {
        if (options?.onlyIf !== undefined && !meets(options.onlyIf, objects.get(key)?.etag)) {
            return null;
        }

        return store(key, copyBytes(value), options?.httpMetadata?.contentType);
    };

    return {
        createMultipartUpload: async (key, options) => {
            uploadCounter += 1;

            const uploadId = `upload-${String(uploadCounter)}`;

            openUploads.set(uploadId, { contentType: options?.httpMetadata?.contentType, key, parts: new Map() });

            return multipart(key, uploadId);
        },
        delete: async (keys) => {
            for (const key of typeof keys === "string" ? [keys] : keys) {
                objects.delete(key);
            }
        },
        get: async (key): Promise<R2ObjectBodyLike | null> => {
            const object = objects.get(key);

            if (object === undefined) {
                return null;
            }

            return {
                ...project(key, object),
                arrayBuffer: async () => new Uint8Array(object.bytes).buffer,
                body: new Blob([new Uint8Array(object.bytes)]).stream(),
                text: async () => new TextDecoder().decode(object.bytes),
            };
        },
        // Two entries per page, so the provider's pagination is exercised.
        list: async (options) => {
            const prefix = options?.prefix ?? "";
            const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).toSorted(byCodeUnit);
            const { delimiter } = options ?? {};
            const direct = delimiter === undefined ? keys : keys.filter((key) => !key.slice(prefix.length).includes(delimiter));
            const delimitedPrefixes =
                delimiter === undefined
                    ? []
                    : [
                          ...new Set(
                              keys
                                  .filter((key) => key.slice(prefix.length).includes(delimiter))
                                  .map((key) => `${prefix}${key.slice(prefix.length).split(delimiter)[0] ?? ""}${delimiter}`),
                          ),
                      ];
            const start = options?.cursor === undefined ? 0 : Number(options.cursor);
            const page = direct.slice(start, start + 2);
            const truncated = start + 2 < direct.length;

            return {
                delimitedPrefixes,
                objects: page.map((key) => project(key, objects.get(key) as StoredObject)),
                truncated,
                ...(truncated ? { cursor: String(start + 2) } : {}),
            };
        },
        objects,
        openUploads,
        partSizes,
        put: put as R2UploadBucket["put"],
        resumeMultipartUpload: (key, uploadId) => multipart(key, uploadId),
    };
};

// eslint-disable-next-line import/prefer-default-export -- a named test helper
export { createFakeR2UploadBucket };
