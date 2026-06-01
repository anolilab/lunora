/**
 * Minimal projection of `R2Bucket`. Declared structurally so unit tests can
 * pass a plain object double; the real binding satisfies the same shape.
 */
export interface R2BucketLike {
    delete: (key: string) => Promise<void>;
    get: (key: string) => Promise<R2ObjectBodyLike | null>;
    list: (options?: { cursor?: string; delimiter?: string; limit?: number; prefix?: string }) => Promise<{
        cursor?: string;
        objects: R2ObjectLike[];
        truncated?: boolean;
    }>;
    put: (
        key: string,
        body: ReadableStream | ArrayBuffer | Blob | string | null,
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) => Promise<R2ObjectLike>;
}

export interface R2ObjectLike {
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    size: number;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
    arrayBuffer: () => Promise<ArrayBuffer>;
    body: ReadableStream | null;
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
    /** Optional content-type allowlist; the supplied `contentType` must match. */
    allowedContentTypes?: ReadonlyArray<string>;
    contentType?: string;
    customMetadata?: Record<string, string>;

    /**
     * Maximum body size in bytes. Enforced for `ArrayBuffer`/`Blob` sources
     * whose length is known synchronously; ignored for `ReadableStream`.
     */
    maxSize?: number;
}

export interface ListOptions {
    cursor?: string;
    /** R2 list delimiter — when set, common prefixes group instead of listing. */
    delimiter?: string;
    /** Defaults to 100, capped at 1000 (R2 limit). */
    limit?: number;
}

export interface SignedUrlOptions {
    expiresInSeconds?: number;
    method?: "GET" | "PUT";
}

export interface Storage {
    delete: (key: string) => Promise<void>;
    download: (key: string) => Promise<R2ObjectBodyLike | null>;
    getSignedUrl: (key: string, options?: SignedUrlOptions) => Promise<string>;
    getUrl: (key: string) => string;
    list: (prefix?: string, options?: ListOptions) => Promise<{ cursor?: string; objects: R2ObjectLike[] }>;
    upload: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: UploadOptions) => Promise<{ etag: string; key: string }>;
}
