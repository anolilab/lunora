/**
 * Types shared by the binding-backed upload provider
 * (`createR2BindingUploadStorage`): the slice of the R2 binding it calls, and
 * the per-upload state it keeps in the bucket.
 */
import type { File } from "@visulima/storage";

/** A stored object as the binding returns it from `put`. */
export interface R2UploadBucketObject {
    etag: string;
}

/** A stored object with its body, as the binding returns it from `get`. */
export interface R2UploadBucketObjectBody extends R2UploadBucketObject {
    arrayBuffer: () => Promise<ArrayBuffer>;
}

/** The part of R2's `R2MultipartUpload` the provider uses. */
export interface R2UploadBucketMultipartUpload {
    abort: () => Promise<void>;
    complete: (uploadedParts: UploadedPart[]) => Promise<R2UploadBucketObject>;
    readonly uploadId: string;
    uploadPart: (partNumber: number, value: ArrayBuffer | ArrayBufferView) => Promise<UploadedPart>;
}

/**
 * The part of a Worker's `R2Bucket` binding the provider uses. A real
 * `env.BUCKET` (and miniflare's) satisfies it, and so does a small in-memory
 * fake. It needs conditional puts (`onlyIf.etagMatches`) and the multipart API.
 */
export interface R2UploadBucket {
    createMultipartUpload: (key: string, options?: { httpMetadata?: { contentType?: string } }) => Promise<R2UploadBucketMultipartUpload>;
    delete: (keys: string | string[]) => Promise<void>;
    // R2 answers a missing key with `null`; the type mirrors the binding.
    get: (key: string) => Promise<R2UploadBucketObjectBody | null>;
    list: (options?: { cursor?: string; prefix?: string }) => Promise<{ cursor?: string; objects: ListedObject[]; truncated: boolean }>;
    put: (
        key: string,
        value: ArrayBuffer | ArrayBufferView | string,
        options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches?: string } },
        // A failed `onlyIf` precondition answers `null`, as the binding does.
    ) => Promise<R2UploadBucketObject | null>;
    resumeMultipartUpload: (key: string, uploadId: string) => R2UploadBucketMultipartUpload;
}

/** An entry of an R2 `list()` page. */
export interface ListedObject {
    key: string;
    uploaded: Date;
}

/** A stored part of a multipart upload. */
export interface UploadedPart {
    etag: string;
    partNumber: number;
}

/** A leftover chunk (less than one part) waiting in the bucket for the next request. */
export interface Segment {
    key: string;
    size: number;
}

/** The upload's file record as plain data (it is stored as JSON, never as a `File` instance). */
export type FileRecord = Pick<File, keyof File>;

/** What the provider stores per upload next to the public file record. */
export interface UploadProgress {
    lock?: { expiresAt: number; token: string };
    parts: UploadedPart[];
    segments: Segment[];
    uploadId?: string;
}

export interface UploadState {
    file: FileRecord;
    upload: UploadProgress;
}
