import type { R2BucketLike, R2MultipartUploadLike, R2ObjectBodyLike, R2ObjectLike, R2RangeLike } from "@lunora/platform";

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

export interface LunoraStorageOptions {
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
     * Maximum body size in bytes. For `ArrayBuffer`/`Blob` sources the length is
     * known up front and rejected before the upload starts. For a
     * `ReadableStream` the length isn't known synchronously, so the stream is
     * piped through a byte counter that aborts the upload once the limit is
     * exceeded — this also guards against R2 silently accepting/truncating an
     * unbounded stream.
     */
    maxSize?: number;

    /**
     * SHA-256 of the body (hex or a 32-byte buffer), recorded with the object.
     *
     * R2 only reports a checksum it was given: without this, `list()`/`head()`
     * return no `sha256` and any later integrity check degrades to comparing
     * sizes. R2 also verifies the digest itself on write, so supplying it turns
     * the upload into a checked one.
     */
    sha256?: ArrayBuffer | string;
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
     * exactly this content-type; mirrored on the URL as `&ct=...`. Ignored for
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
     * {@link LunoraStorageOptions.s3} credentials; throws if they're absent. For
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
    store: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: UploadOptions) => Promise<{ etag: string; httpEtag: string; key: string }>;
    upload: (key: string, body: ReadableStream | ArrayBuffer | Blob, options?: UploadOptions) => Promise<{ etag: string; httpEtag: string; key: string }>;
}

export {
    type R2BucketLike,
    type R2MultipartUploadLike,
    type R2ObjectBodyLike,
    type R2ObjectLike,
    type R2RangeLike,
    type R2UploadedPartLike,
} from "@lunora/platform";
