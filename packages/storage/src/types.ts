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
    /** Seconds the URL stays valid: 1 to 604800 (7 days); an out-of-range value throws. Default 900. */
    expiresInSeconds?: number;
    /** HTTP method the URL authorizes. Default `GET`. */
    method?: "GET" | "PUT";
}

export interface LunoraStorageOptions {
    bucket: R2BucketLike;

    /**
     * The name this bucket is registered under — the same string a
     * `defineStorageRule({ bucket })` rule and the generated `StorageBucketName`
     * union use. Bound into every signed URL's HMAC and mirrored on it as
     * `&bucket=`, so a URL minted for one bucket can't be replayed against
     * another sharing the signing secret, and the serving route can resolve
     * which bucket to read.
     *
     * Required, and deliberately without a default: a defaulted name is how
     * every bucket ended up signing as `"default"` and cross-verifying against
     * each other. Pass `"default"` for a single-bucket app's `ctx.storage`, and
     * the registered name for any bucket reached through `createBucketStorage`.
     */
    bucketName: string;
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
     * known up front and rejected before the upload starts.
     *
     * A `ReadableStream` has no length to check, and R2 refuses any stream whose
     * length it cannot read — so a capped stream is READ INTO MEMORY under the
     * cap and uploaded as a sized body. Nothing reaches the bucket if the body
     * crosses the limit. `maxSize` is therefore also the memory ceiling for a
     * streamed upload: for objects too large to hold in a Worker, either omit
     * `maxSize` (R2 then reads the body's own length and streams it through) or
     * use `createMultipartUpload` / `createUploadHandler`.
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
     * The bucket name this accessor operates under — the same value
     * {@link Storage.getSignedUrl} puts into the HMAC canonical.
     *
     * Exposed so everything downstream agrees on one name: `asBucketStorage`
     * tags a single-bucket storage with it, and `storageRules(...)` matches
     * `(bucket, operation)` rules against that tag. Without it a
     * `createStorage({ bucketName: "avatars" })` signed URLs as `avatars` while
     * the rules engine only ever saw `"default"`.
     */
    readonly bucketName: string;

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
     * custom metadata) without fetching its body, as a flat serializable shape.
     * Returns `null` when the object is absent. A projection of
     * {@link Storage.head}, so it makes the same single body-free read. Mirrors
     * Convex's `ctx.storage.getMetadata`.
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

    /**
     * Read an object's R2 metadata WITHOUT its body — `size` (the full object
     * size), `etag`, `httpMetadata`, `checksums`, plus the `sha256`/`sha256Base64`
     * projection `download()` adds. Returns `null` when the object is absent.
     *
     * Backed by an R2 HEAD when the binding exposes one, falling back to a
     * 0-length ranged `get()` otherwise. Prefer this over `download()` whenever
     * only the metadata is wanted — notably to resolve a `Range` header, where a
     * plain `download()` starts a full-object body transfer that is then thrown
     * away. {@link Storage.getMetadata} is the flat, serializable projection of
     * the same read.
     */
    head: (key: string) => Promise<R2ObjectLike | null>;

    /**
     * List objects under `prefix`. With `options.delimiter` set, keys sharing a
     * segment are rolled up into `delimitedPrefixes` (the "folders") and are NOT
     * in `objects` — a folder browser needs both, so a listing whose `objects` is
     * empty is not an empty directory.
     */
    list: (prefix?: string, options?: ListOptions) => Promise<{ cursor?: string; delimitedPrefixes?: string[]; objects: R2ObjectLike[]; truncated?: boolean }>;

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
