/**
 * The `ctx.storage` surface, per function tier: {@link ReadOnlyStorage} for a
 * query, {@link MutationStorage} for a mutation, {@link Storage} for an action.
 *
 * A structural mirror of `@lunora/storage`'s `Storage` — `@lunora/server` takes
 * no dependency on that package. Re-exported through `../types`, so the public
 * names are unchanged.
 */

/**
 * Per-file metadata returned by {@link ReadOnlyStorage.getMetadata}. A clean
 * public mirror of `@lunora/storage`'s `ObjectMetadata` — re-declared here so
 * the ctx surface carries no dependency on the storage package's types. Matches
 * the columns Convex surfaces for `ctx.storage.getMetadata` / `_storage`.
 */
interface StorageMetadata {
    /** The object's `Content-Type`, when recorded. */
    contentType?: string;
    /** Custom metadata set at upload time, if any. */
    customMetadata?: Record<string, string>;
    /** The object's key. */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Body length in bytes. */
    size: number;
    /** When the object was last written (epoch ms), when reported. */
    uploaded?: number;
}

/**
 * The body-free object shape returned by {@link ReadOnlyStorage.head} — a clean
 * public mirror of `@lunora/storage`'s head projection, re-declared here for the
 * same reason as {@link StorageMetadata}: the ctx surface carries no dependency
 * on the storage package's types.
 *
 * Richer than {@link StorageMetadata} on purpose. `getMetadata` is the tidy
 * Convex-shaped summary; `head` is what an HTTP layer needs, so it keeps the
 * validator (`etag`) and the base64 digest RFC 9530 `Repr-Digest` requires, and
 * leaves `uploaded` as the `Date` the binding reports rather than epoch ms.
 */
interface StorageObjectHead {
    /** Custom metadata set at upload time, if any. */
    customMetadata?: Record<string, string>;

    /**
     * R2's unquoted etag (the MD5 hex for a single-part upload). Required: R2
     * reports one on every object, and an HTTP layer built on `head()` (the
     * `serveStorageObject` helper) needs it to emit a validator.
     */
    etag: string;
    /** The already-quoted form of {@link StorageObjectHead.etag}, when the binding reports one. */
    httpEtag?: string;
    /** Recorded HTTP metadata, notably the `Content-Type`. */
    httpMetadata?: { contentType?: string };
    /** The object's key. */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Base64-encoded SHA-256 of the same checksum — the encoding RFC 9530 digest headers require. */
    sha256Base64?: string;
    /** The FULL object size in bytes: R2 reports the object's size, not a returned window's, which is what makes a head enough to resolve a `Range` against. */
    size: number;
    /** When the object was last written. */
    uploaded?: Date;
}

/**
 * Byte window forwarded to {@link ReadOnlyStorage.download} so R2 resolves the
 * slice server-side and streams only those bytes back. Mirrors R2's own `range`
 * option (`@lunora/platform`'s `R2RangeLike`), restated structurally so
 * `@lunora/server` takes no dependency on the bindings package.
 */
type StorageRange = { length?: number; offset: number } | { length: number; offset?: number } | { suffix: number };

/**
 * A downloaded object: the same metadata {@link StorageObjectHead} carries, plus
 * the body stream. This is what `download()` resolves to — R2's object, NOT a
 * bare stream.
 */
interface StorageObjectBody extends StorageObjectHead {
    /** The object body stream. `null` for a zero-byte object. */
    body: ReadableStream | null;
}

/**
 * Read-only projection of `Storage` exposed on `QueryCtx` / `MutationCtx`.
 *
 * Queries are pure reads, and mutations run inside a transactional scope —
 * neither is allowed to perform side-effectful R2 writes (`upload`) or
 * deletes (`delete`). They can, however, **read** existing objects and
 * resolve signed URLs (the URL signing itself is HMAC-only — no R2 round
 * trip), so the read-only surface keeps `download` and `getSignedUrl`. The
 * full {@link Storage} surface stays on `ActionCtx`.
 */
interface ReadOnlyStorage<Buckets extends string = string> {
    /**
     * Select a named bucket (declared via `v.storage("name")`). The returned
     * accessor's operations target that bucket — `ctx.storage.bucket("avatars")
     * .download(key)`. The bare `ctx.storage` targets the default bucket.
     */
    bucket: (name: Buckets) => ReadOnlyStorage<Buckets>;

    /** The bucket this accessor's operations target (the default for the bare `ctx.storage`). */
    readonly bucketName: string;

    /**
     * Fetch an existing object. Returns the R2 object — metadata plus a `body`
     * stream — or `null` when absent.
     *
     * NOT a bare stream: `new Response(await ctx.storage.download(key))` would
     * stringify the object and serve the literal text `[object Object]`. Reach
     * for the body explicitly:
     *
     * ```ts
     * const object = await ctx.storage.download(key);
     *
     * return object ? new Response(object.body) : new Response("Not found", { status: 404 });
     * ```
     *
     * (`serveStorageObject` from `@lunora/server` does this, plus range/ETag
     * handling, for the common "serve a stored file over HTTP" case.)
     *
     * Pass `range` to have R2 resolve the byte window server-side, so the
     * unwanted bytes never reach the worker.
     */
    download: (key: string, options?: { range?: StorageRange }) => Promise<StorageObjectBody | null>;

    /**
     * Read a file's metadata (size, content-type, sha256, upload time, custom
     * metadata) without fetching its body. Returns `null` when the object is
     * absent. Mirrors Convex's `ctx.storage.getMetadata`.
     */
    getMetadata: (key: string) => Promise<StorageMetadata | null>;
    /** Resolve a short-lived signed URL for an existing object. */
    getSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
    /** Public URL pointing at the configured base for `key`. */
    getUrl: (key: string) => string;

    /**
     * Read an object's metadata with NO body transfer, as the raw object shape —
     * `etag` and the base64 digest included, which is what an HTTP layer needs to
     * answer a `Range` request. Returns `null` when the object is absent.
     *
     * {@link ReadOnlyStorage.getMetadata} is the tidier summary over the same
     * read; reach for this one when building a response.
     */
    head: (key: string) => Promise<StorageObjectHead | null>;
}

/**
 * `ctx.storage` inside a **mutation**: the read surface, plus the one write a
 * transactional context can safely express. See `@lunora/server`'s
 * `deferred-deletes.ts` for why `delete` itself stays action-only.
 */
interface MutationStorage<Buckets extends string = string> extends ReadOnlyStorage<Buckets> {
    /** Select a named bucket; deletes queued on it are flushed against that bucket. */
    bucket: (name: Buckets) => MutationStorage<Buckets>;

    /**
     * Queue `key` for deletion once this mutation commits.
     *
     * Returns `void`, not a promise: nothing has been attempted yet, so the object
     * is still there on the next line. A rolled-back mutation never flushes, so
     * the row deletion and the object cleanup cannot disagree. A failed delete
     * leaks the object rather than failing a mutation that already succeeded, and
     * is logged with its key.
     */
    deleteAfterCommit: (key: string) => void;
}

/**
 * The body shapes `store` / `upload` accept — what R2's `put` stores bytes from.
 * Mirrors `@lunora/storage`'s `Storage.upload` parameter.
 */
type StorageUploadBody = ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string;

/**
 * Options for `store` / `upload` — a structural mirror of `@lunora/storage`'s
 * `UploadOptions`, so the `maxSize` / `allowedContentTypes` guards are reachable
 * from `ctx.storage` without a type dependency on the storage package.
 */
interface StorageUploadOptions {
    /** Content-type allowlist; the supplied `contentType` must match. */
    allowedContentTypes?: ReadonlyArray<string>;
    contentType?: string;
    customMetadata?: Record<string, string>;

    /**
     * Maximum body size in bytes. A `ReadableStream` is buffered under the cap,
     * so on the stream path `maxSize` is itself capped at 16 MiB — above that use
     * {@link Storage.createMultipartUpload}.
     */
    maxSize?: number;
    /** SHA-256 of the body (hex or a 32-byte buffer); R2 records and verifies it. */
    sha256?: ArrayBuffer | string;
}

/** What `store` / `upload` resolve to: the stored key plus its etag (unquoted and quoted). */
interface StorageUploadResult {
    etag: string;
    httpEtag: string;
    key: string;
}

/** One uploaded multipart part — returned by `uploadPart`, required by `complete`. Mirrors R2's `R2UploadedPart`. */
interface StorageUploadedPart {
    etag: string;
    partNumber: number;
}

/**
 * An in-progress R2 multipart upload, as {@link Storage.createMultipartUpload} /
 * {@link Storage.resumeMultipartUpload} return it. A structural mirror of
 * R2's own multipart upload handle, as `@lunora/platform` declares it.
 *
 * Every part except the last must be the same size, and at least 5 MiB. The
 * object does not guarantee the upload still exists — a parallel `complete` /
 * `abort` invalidates it — so handle errors on each call.
 */
interface StorageMultipartUpload {
    /** Abort the upload, discarding every uploaded part. */
    abort: () => Promise<void>;
    /** Finish the upload from the collected parts; resolves to the stored object's metadata. */
    complete: (uploadedParts: StorageUploadedPart[]) => Promise<StorageObjectHead>;
    /** The object key being assembled. */
    readonly key: string;
    /** The R2 upload id — persist it to resume the upload in a later request. */
    readonly uploadId: string;
    /** Upload one part (1-indexed); returns the `{ partNumber, etag }` to pass to `complete`. */
    uploadPart: (partNumber: number, value: StorageUploadBody) => Promise<StorageUploadedPart>;
}

/** Options for {@link Storage.createMultipartUpload}: the metadata recorded on the assembled object. */
interface StorageMultipartUploadOptions {
    contentType?: string;
    customMetadata?: Record<string, string>;
}

/** Options for {@link Storage.list}. Mirrors `@lunora/storage`'s `ListOptions`. */
interface StorageListOptions {
    /** The `cursor` of the previous page. */
    cursor?: string;
    /** R2 list delimiter — keys sharing a segment roll up into `delimitedPrefixes`. */
    delimiter?: string;
    /** Page-size ceiling: defaults to 100, capped at 1000. A positive integer; anything else throws. */
    limit?: number;
}

/** One page of {@link Storage.list}. */
interface StorageListResult {
    /** Pass back as `options.cursor` for the next page, while `truncated` is `true`. */
    cursor?: string;
    /** The rolled-up "folders" when `options.delimiter` is set — these are NOT in `objects`. */
    delimitedPrefixes?: string[];
    /** The objects on this page, body-free and JSON-serializable. */
    objects: StorageObjectHead[];
    /** `true` while more pages remain. Paginate on this, never on `objects.length`. */
    truncated?: boolean;
}

/**
 * `ctx.storage` inside an **action**: the full `@lunora/storage` `Storage`
 * surface, plus `bucket(name)`.
 *
 * Declared structurally rather than imported — `@lunora/server` takes no
 * runtime or published-type dependency on `@lunora/storage` — so it tracks that
 * surface by hand. A type test (`__tests__/storage-surface.test-d.ts`) fails
 * `tsc` when the two drift —
 * the member sets differ (a runtime member left untyped here, or a member typed
 * here the runtime lacks — `bucket` aside, which the ctx wiring adds); the
 * runtime object no longer satisfies a signature here (a return type widened,
 * or a parameter narrowed, upstream); or a parameter list here differs from the
 * runtime's (an option or body shape the runtime takes but this interface
 * refuses). `getSignedUrl` is the one deliberate parameter exception: its PUT
 * options would mint an upload URL from a query.
 *
 * Return types here may be NARROWER than the runtime's on purpose — `head`
 * resolves to the {@link StorageObjectHead} mirror rather than R2's object.
 *
 * Every member here is action-only. Under a procedure guarded by
 * `storageRules(...)`, the write paths (`store` / `upload` /
 * `createMultipartUpload` / `resumeMultipartUpload`) are gated as `write`, and
 * `getPresignedUrl` / `list`, which no rule can gate, reject with `FORBIDDEN`.
 */
interface Storage<Buckets extends string = string> extends ReadOnlyStorage<Buckets> {
    /** Select a named bucket; the returned accessor exposes the full read/write surface. */
    bucket: (name: Buckets) => Storage<Buckets>;

    /**
     * Begin a native R2 **multipart upload** — for objects above `store()`'s
     * 16 MiB stream cap, streamed through the Worker without buffering. Upload
     * the parts (each at least 5 MiB and uniform in size, except the last), then
     * `complete` with the returned parts, or `abort`. Persist `uploadId` to
     * continue in a later request via {@link Storage.resumeMultipartUpload}.
     */
    createMultipartUpload: (key: string, options?: StorageMultipartUploadOptions) => Promise<StorageMultipartUpload>;

    delete: (key: string) => Promise<void>;

    /**
     * Mint a short-lived signed `PUT` URL a client can upload directly to,
     * optionally pinning the `Content-Type` the uploader must send. Mirrors
     * Convex's `storage.generateUploadUrl`.
     */
    generateUploadUrl: (key: string, options?: { contentType?: string; expiresInSeconds?: number }) => Promise<string>;

    /**
     * Mint a native S3 SigV4 URL that hits R2 **directly**, so the bytes never
     * pass through the Worker — unlike {@link Storage.generateUploadUrl}, whose
     * signed URL points back at this app so its storage rules still apply.
     *
     * Requires `s3` credentials on the `.storage({ s3 })` declaration; without
     * them the call throws. That is the trade-off: no Worker in the path also
     * means no rule enforcement in the path.
     */
    getPresignedUrl: (key: string, options?: { expiresInSeconds?: number; method?: "GET" | "PUT" }) => Promise<string>;

    /**
     * List objects under `prefix` — e.g. to sweep abandoned staging uploads. With
     * `options.delimiter` set, keys sharing a segment roll up into
     * `delimitedPrefixes` and are NOT in `objects`, so an empty `objects` is not
     * an empty directory. A page may hold fewer objects than `options.limit`:
     * paginate on `truncated` / `cursor`.
     *
     * Not gated by storage access rules (and dropped under `storageRules(...)`);
     * a rule-scoped enumeration goes through `ctx.db.system.query("_storage")`.
     */
    list: (prefix?: string, options?: StorageListOptions) => Promise<StorageListResult>;

    /**
     * Resume an in-progress multipart upload by its `uploadId` (e.g. across
     * requests). Synchronous: R2 does not validate the id, so a stale one
     * surfaces as an error on the first `uploadPart` / `complete`.
     */
    resumeMultipartUpload: (key: string, uploadId: string) => StorageMultipartUpload;

    /**
     * Upload `body` to `key` from the server, returning the stored object's key
     * and etag. Mirrors Convex's `storage.store`; the same function as
     * {@link Storage.upload}, so the `maxSize` / `allowedContentTypes` guards
     * apply through the alias.
     */
    store: (key: string, body: StorageUploadBody, options?: StorageUploadOptions) => Promise<StorageUploadResult>;

    /** Upload `body` to `key` — {@link Storage.store} under `@lunora/storage`'s own name, with one shared signature. */
    upload: Storage<Buckets>["store"];
}

export type {
    MutationStorage,
    ReadOnlyStorage,
    Storage,
    StorageListOptions,
    StorageListResult,
    StorageMetadata,
    StorageMultipartUpload,
    StorageMultipartUploadOptions,
    StorageObjectBody,
    StorageObjectHead,
    StorageRange,
    StorageUploadBody,
    StorageUploadedPart,
    StorageUploadOptions,
    StorageUploadResult,
};
