/**
 * A single-range read against R2: an `{ offset, length }` window (at least one
 * bound required, mirroring R2's own `R2Range`) or a `{ suffix }` tail. The
 * subset of `R2Range` that {@link Storage.download} forwards so a caller can
 * stream just the bytes it needs instead of the whole object.
 */
export type R2RangeLike = { length: number; offset?: number } | { length?: number; offset: number } | { suffix: number };

/**
 * Minimal projection of `R2Bucket`. Declared structurally so unit tests can
 * pass a plain object double; the real binding satisfies the same shape.
 */
export interface R2BucketLike {
    /**
     * Begin a multipart upload (R2 `createMultipartUpload`). Optional so existing
     * test doubles still satisfy the type; {@link Storage.createMultipartUpload}
     * throws a clear error when the binding lacks it.
     */
    createMultipartUpload?: (
        key: string,
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) => Promise<R2MultipartUploadLike>;
    delete: (key: string) => Promise<void>;
    get: (key: string, options?: { range?: R2RangeLike }) => Promise<R2ObjectBodyLike | null>;

    /**
     * Fetch an object's metadata without its body (R2 HEAD). Returns `null` when
     * the object is absent. Declared optional so existing test doubles that only
     * implement `get`/`put`/`list`/`delete` still satisfy the type; callers that
     * need metadata fall back to a 0-length ranged `get()` when `head` is absent.
     */
    head?: (key: string) => Promise<R2ObjectLike | null>;
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
    /** Resume an in-progress multipart upload by id (R2 `resumeMultipartUpload`). Optional; see {@link Storage.resumeMultipartUpload}. */
    resumeMultipartUpload?: (key: string, uploadId: string) => R2MultipartUploadLike;
}

/** One uploaded multipart part — returned by `uploadPart`, required to `complete`. Mirrors R2's `R2UploadedPart`. */
export interface R2UploadedPartLike {
    etag: string;
    partNumber: number;
}

/**
 * An in-progress multipart upload, mirroring R2's `R2MultipartUpload`. Each part
 * (except the last) must be uniform in size. The object does not guarantee the
 * underlying upload still exists — a parallel `complete`/`abort` can invalidate
 * it — so wrap each call in error handling.
 */
export interface R2MultipartUploadLike {
    /** Abort the upload, discarding any uploaded parts. */
    abort: () => Promise<void>;
    /** Finish the upload from the collected parts; resolves to the stored object. */
    complete: (uploadedParts: R2UploadedPartLike[]) => Promise<R2ObjectLike>;
    /** The object key being assembled. */
    readonly key: string;
    /** The R2 upload id (persist it to resume across requests). */
    readonly uploadId: string;
    /** Upload one part (1-indexed); returns the `{ partNumber, etag }` to pass to `complete`. */
    uploadPart: (partNumber: number, value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string) => Promise<R2UploadedPartLike>;
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

    /**
     * Base64-encoded SHA-256 of the object body, surfaced alongside
     * {@link R2ObjectLike.sha256} from the same checksum. Base64 is the encoding
     * RFC 9530 digest headers (`Repr-Digest`/`Content-Digest`) require, so HTTP
     * layers can emit a spec-compliant digest without re-deriving it.
     */
    sha256Base64?: string;
    size: number;

    /**
     * When the object was written. The real binding exposes this as a `Date`;
     * declared optional so fakes that omit it still type-check.
     * {@link Storage.getMetadata} normalises it to epoch ms.
     */
    uploaded?: Date;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
    arrayBuffer: () => Promise<ArrayBuffer>;
    body: ReadableStream | null;
    text: () => Promise<string>;
}

/**
 * R2 S3-API credentials for {@link Storage.getPresignedUrl}. These are an R2 API
 * token's Access Key ID / Secret Access Key (NOT a Cloudflare API token), plus
 * the account id and bucket name. Required only if you call `getPresignedUrl`;
 * the worker-signed URL path (`getSignedUrl`) needs none of this.
 */
export interface R2S3Credentials {
    /** R2 S3 Access Key ID. */
    accessKeyId: string;
    /** Cloudflare account id — the account portion of the S3 endpoint host. */
    accountId: string;
    /** Bucket name (used in the path-style key prefix). */
    bucket: string;
    /** Optional data-location jurisdiction. Omit for the default global endpoint. */
    jurisdiction?: "eu" | "fedramp";
    /** R2 S3 Secret Access Key. */
    secretAccessKey: string;
}

/** Options for {@link Storage.getPresignedUrl}. */
export interface PresignedUrlOptions {
    /** Seconds the URL stays valid; clamped to [1, 604800]. Default 900. */
    expiresInSeconds?: number;
    /** HTTP method the URL authorizes. Default `GET`. */
    method?: "GET" | "PUT";
}

export interface CirrusStorageOptions {
    bucket: R2BucketLike;
    /** Public base URL used by `getSignedUrl()`. Required for signed URLs. */
    publicBaseUrl?: string;

    /**
     * R2 S3-API credentials enabling {@link Storage.getPresignedUrl} (native S3
     * presigned URLs that hit R2 directly, bypassing the Worker). Omit to use
     * only the worker-signed URL path.
     */
    s3?: R2S3Credentials;
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

/**
 * Per-object metadata returned by {@link Storage.getMetadata} — a flat,
 * body-free projection of {@link R2ObjectLike}. Mirrors the shape Convex
 * surfaces for `ctx.storage.getMetadata` / the `_storage` system table.
 */
export interface ObjectMetadata {
    /** The object's `Content-Type` (R2 `httpMetadata.contentType`), if recorded. */
    contentType?: string;
    /** Custom metadata set at upload time (R2 `customMetadata`), if any. */
    customMetadata?: Record<string, string>;
    /** The object's key. */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Body length in bytes. */
    size: number;
    /** When the object was last written (epoch ms), when R2 reports it. */
    uploaded?: number;
}

export interface Storage {
    /**
     * Begin a native R2 **multipart upload** for very large objects — upload
     * parts (each uniform in size except the last), then `complete` with the
     * returned parts (or `abort`). Wraps R2's `createMultipartUpload`; throws if
     * the bound bucket doesn't support it. For ordinary uploads use
     * {@link Storage.upload} / {@link Storage.store}.
     */
    createMultipartUpload: (key: string, options?: { contentType?: string; customMetadata?: Record<string, string> }) => Promise<R2MultipartUploadLike>;
    delete: (key: string) => Promise<void>;

    /**
     * Fetch a stored object's metadata + body. Pass `options.range` to stream
     * only a byte window (R2 resolves the range server-side, so the unwanted
     * bytes never reach the Worker) — `download(key)` reads the whole object.
     */
    download: (key: string, options?: { range?: R2RangeLike }) => Promise<R2ObjectBodyLike | null>;

    /**
     * Mint a short-lived signed `PUT` URL a client can upload directly to,
     * optionally pinning the request `Content-Type`. Convex-compatible alias
     * built on {@link Storage.getSignedUrl} with `method: "PUT"`.
     */
    generateUploadUrl: (key: string, options?: { contentType?: string; expiresInSeconds?: number }) => Promise<string>;

    /**
     * Read a stored object's metadata (size, content-type, sha256, upload time,
     * custom metadata) without fetching its body. Returns `null` when the object
     * is absent. Backed by an R2 HEAD (`bucket.head`) when available, falling
     * back to a 0-length ranged `get()` otherwise. Mirrors Convex's
     * `ctx.storage.getMetadata`.
     */
    getMetadata: (key: string) => Promise<ObjectMetadata | null>;

    /**
     * Mint a native S3 **presigned URL** (SigV4) that hits R2 directly, bypassing
     * the Worker. Use for large downloads/uploads where you don't need per-request
     * app gating and want the bytes off the Worker's CPU/bandwidth budget. Requires
     * {@link CirrusStorageOptions.s3} credentials; throws if they're absent. For
     * app-gated access (auth/policy/rate-limit) prefer {@link Storage.getSignedUrl}.
     */
    getPresignedUrl: (key: string, options?: PresignedUrlOptions) => Promise<string>;
    getSignedUrl: (key: string, options?: SignedUrlOptions) => Promise<string>;
    getUrl: (key: string) => string;
    list: (prefix?: string, options?: ListOptions) => Promise<{ cursor?: string; objects: R2ObjectLike[]; truncated?: boolean }>;

    /**
     * Resume an in-progress multipart upload by its `uploadId` (e.g. across
     * requests). Wraps R2's `resumeMultipartUpload`; the id is not validated by
     * R2, so a stale id surfaces as an error on the first `uploadPart`/`complete`.
     */
    resumeMultipartUpload: (key: string, uploadId: string) => R2MultipartUploadLike;

    /**
     * Upload `body` to `key`, returning the stored key + etag. Convex-compatible
     * alias for {@link Storage.upload} — it accepts the same {@link UploadOptions}
     * so the `maxSize` / `allowedContentTypes` guards aren't lost behind the alias.
     */
    store: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: UploadOptions) => Promise<{ etag: string; key: string }>;
    upload: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: UploadOptions) => Promise<{ etag: string; key: string }>;
}
