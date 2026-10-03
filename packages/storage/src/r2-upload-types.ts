/**
 * Types of the binding-backed upload provider (`createR2BindingUploadStorage`):
 * the bucket it needs, and the per-upload state it keeps in that bucket.
 */
import type { R2BucketLike, R2UploadedPartLike } from "@lunora/platform";
import type { File } from "@visulima/storage";

/**
 * An R2 binding with the multipart API: a Worker's `env.BUCKET` (and
 * miniflare's). The provider also relies on `put`'s `onlyIf` preconditions,
 * which every R2 binding honors.
 */
export type R2UploadBucket = R2BucketLike & Required<Pick<R2BucketLike, "createMultipartUpload" | "resumeMultipartUpload">>;

/** A leftover chunk (less than one part) waiting in the bucket for the next request. */
export interface Segment {
    key: string;
    size: number;
}

/** The upload's file record as plain data (it is stored as JSON, never as a `File` instance). */
export type FileRecord = Pick<File, keyof File>;

/** What the provider stores per upload next to the public file record. */
export interface UploadProgress {
    lock?: UploadLock;
    parts: R2UploadedPartLike[];
    segments: Segment[];
    uploadId?: string;
}

/** A request's lease on an upload. */
export interface UploadLock {
    expiresAt: number;
    token: string;
}

export interface UploadState {
    file: FileRecord;
    upload: UploadProgress;
}
