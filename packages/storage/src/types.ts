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
    /**
     * R2-computed checksums. The real binding exposes `sha256` as an
     * `ArrayBuffer` (present only when R2 stored a SHA-256 for the object);
     * declared optional so fakes and non-checksummed objects type-check.
     */
    checksums?: { sha256?: ArrayBuffer };
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;

    /**
     * Hex-encoded SHA-256 of the object body, surfaced by `download()`/`list()`
     * when R2 carries a checksum (derived from {@link R2ObjectLike.checksums}).
     */
    sha256?: string;
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
    /**
     * Pin the `Content-Type` an uploader must send on a `method: "PUT"` URL.
     * Baked into the HMAC canonical so the signature only authorizes a PUT with
     * exactly this content-type; mirrored on the URL as `&amp;ct=...`. Ignored for
     * `GET` URLs (a download has no request body content-type to pin).
     */
    contentType?: string;
    expiresInSeconds?: number;
    method?: "GET" | "PUT";
}

export interface Storage {
    delete: (key: string) => Promise<void>;
    download: (key: string) => Promise<R2ObjectBodyLike | null>;

    /**
     * Mint a short-lived signed `PUT` URL a client can upload directly to,
     * optionally pinning the request `Content-Type`. Convex-compatible alias
     * built on {@link Storage.getSignedUrl} with `method: "PUT"`.
     */
    generateUploadUrl: (key: string, options?: { contentType?: string; expiresInSeconds?: number }) => Promise<string>;
    getSignedUrl: (key: string, options?: SignedUrlOptions) => Promise<string>;
    getUrl: (key: string) => string;
    list: (prefix?: string, options?: ListOptions) => Promise<{ cursor?: string; objects: R2ObjectLike[]; truncated?: boolean }>;

    /**
     * Upload `body` to `key`, returning the stored key + etag. Convex-compatible
     * alias for {@link Storage.upload}.
     */
    store: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: { contentType?: string }) => Promise<{ etag: string; key: string }>;
    upload: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: UploadOptions) => Promise<{ etag: string; key: string }>;
}
