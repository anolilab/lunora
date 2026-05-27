/**
 * Minimal projection of `R2Bucket`. Declared structurally so unit tests can
 * pass a plain object double; the real binding satisfies the same shape.
 */
export interface R2BucketLike {
    put: (
        key: string,
        body: ReadableStream | ArrayBuffer | Blob | string | null,
        options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
    ) => Promise<R2ObjectLike>;
    get: (key: string) => Promise<R2ObjectBodyLike | null>;
    delete: (key: string) => Promise<void>;
    list: (options?: { prefix?: string; limit?: number; cursor?: string }) => Promise<{ objects: R2ObjectLike[]; cursor?: string; truncated?: boolean }>;
}

export interface R2ObjectLike {
    key: string;
    size: number;
    etag: string;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
    body: ReadableStream | null;
    arrayBuffer: () => Promise<ArrayBuffer>;
    text: () => Promise<string>;
}

export interface CirrusStorageOptions {
    bucket: R2BucketLike;
    /** Public base URL used by `getSignedUrl()`. Required for signed URLs. */
    publicBaseUrl?: string;
    /** HMAC secret used by the worker-signed URL helper. Required for signed URLs. */
    signingSecret?: string;
}

export interface UploadOptions {
    contentType?: string;
    customMetadata?: Record<string, string>;
}

export interface ListOptions {
    limit?: number;
    cursor?: string;
}

export interface SignedUrlOptions {
    expiresInSeconds?: number;
    method?: "GET" | "PUT";
}

export interface Storage {
    upload: (
        key: string,
        body: ReadableStream | ArrayBuffer | Blob,
        opts?: UploadOptions,
    ) => Promise<{ key: string; etag: string }>;
    download: (key: string) => Promise<R2ObjectBodyLike | null>;
    delete: (key: string) => Promise<void>;
    list: (
        prefix?: string,
        opts?: ListOptions,
    ) => Promise<{ objects: R2ObjectLike[]; cursor?: string }>;
    getSignedUrl: (key: string, opts?: SignedUrlOptions) => Promise<string>;
}
