/**
 * Canonical provider-neutral binding projections. These mirror the existing
 * per-package `*Like` types; in later phases each package's copy becomes a
 * type-only re-export of these canonical definitions.
 *
 * For now, this module is additive: existing packages keep their local copies
 * unchanged, so Phase 0 carries zero runtime or type-breaking risk.
 */

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R2 / Object storage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/** Per-message send options. */
export interface QueueSendOptionsLike {
    delaySeconds?: number;
}

/** One message in a batch send. */
export interface QueueSendRequestLike<Body = unknown> {
    body: Body;
    delaySeconds?: number;
}

/** One delivered queue message (consumer side). */
export interface QueueMessageLike<Body = unknown> {
    ack: () => void;
    readonly attempts: number;
    readonly body: Body;
    readonly id: string;
    retry: (options?: { delaySeconds?: number }) => void;
    readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// HTTP cache (Web Cache API)
// ---------------------------------------------------------------------------

/** Options accepted by {@link HttpCacheLike.match} and {@link HttpCacheLike.delete}. */
export interface HttpCacheQueryOptions {
    /** Match a non-`GET` request against a stored `GET` entry. */
    ignoreMethod?: boolean;
}

/**
 * Minimal projection of one Web Cache API cache — the store a host puts in front
 * of the app, reached on Cloudflare as `caches.default` (the colo cache).
 *
 * Only the three calls Lunora makes are declared, so a host that has a cache but
 * not the whole `Cache` interface still satisfies it, and a unit test can pass a
 * plain object double. This is a **host** primitive, not a binding: it is reached
 * through a runtime global rather than `env`, and a target without one leaves it
 * `undefined` rather than shipping a fake — see `httpCache` in
 * `PlatformCapabilities`.
 *
 * The stored entry is keyed by the request, so a caller that needs `Vary`
 * semantics must fold the varying header values into the key itself: Cloudflare's
 * cache honours `Vary` for `Accept-Encoding` only, and a projection cannot make
 * that portable.
 */
export interface HttpCacheLike {
    /** Evict the entry stored under `request`. Resolves `true` when something was removed. */
    delete: (request: Request | string, options?: HttpCacheQueryOptions) => Promise<boolean>;
    /** The stored response for `request`, or `undefined` on a miss. */
    match: (request: Request | string, options?: HttpCacheQueryOptions) => Promise<Response | undefined>;
    /** Store `response` under `request`. Rejects for a `206`, a `Vary: *`, or a `Set-Cookie`-bearing response. */
    put: (request: Request | string, response: Response) => Promise<void>;
}

// ---------------------------------------------------------------------------
// D1 / relational database
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Vectorize
// ---------------------------------------------------------------------------

/** A single vector match. */
export interface VectorMatchLike {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

/** Vector query/upsert record. */
export interface VectorRecordLike {
    id: string;
    metadata?: Record<string, unknown>;
    values: number[];
}

// ---------------------------------------------------------------------------
// Analytics Engine
// ---------------------------------------------------------------------------

/** A single analytics data point. */
export interface AnalyticsEngineDataPointLike {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
}

export interface D1PreparedStatementLike {
    // T lets callers type result rows (e.g. `.all<{ id: string }>()`); it flows
    // from the call site into the return, so it is intentionally caller-supplied.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    all: <T = unknown>() => Promise<{ results: T[]; success: boolean }>;
    bind: (...values: unknown[]) => D1PreparedStatementLike;
    first: <T = unknown>(column?: string) => Promise<T | null>;
    raw: <T = unknown>() => Promise<T[][]>;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    run: <T = unknown>() => Promise<{ meta?: Record<string, unknown>; results?: T[]; success: boolean }>;
}

export interface D1SessionLike {
    batch?: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
    getBookmark: () => string | null;
    prepare: (sql: string) => D1PreparedStatementLike;
}

/**
 * Minimal structural projection of `D1Database` to keep the adapter
 * compatible with the real workers-types value as well as unit-test doubles.
 */
export interface D1DatabaseLike {
    batch?: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
    prepare: (sql: string) => D1PreparedStatementLike;
    withSession: (bookmark?: string) => D1SessionLike;
}

/**
 * One Analytics Engine data point, mirroring the positional shape
 * `writeDataPoint` accepts. AE stores up to 20 string `blobs`, up to 20 numeric
 * `doubles`, and exactly **one** `index` (the high-cardinality sampling key) per
 * data point — the SQL API later exposes them as `blob1..blob20`,
 * `double1..double20`, and `index1`.
 */
export interface AnalyticsEngineDataPoint {
    /** String columns, mapped positionally to `blob1..blob20`. */
    blobs?: (ArrayBuffer | null | string)[];
    /** Numeric columns, mapped positionally to `double1..double20`. */
    doubles?: number[];
    /** Sampling key, exposed as `index1`. AE accepts at most one. */
    indexes?: (ArrayBuffer | string)[];
}

/**
 * Minimal structural projection of workers-types' `AnalyticsEngineDataset`,
 * kept loose enough for a plain-object fake in unit tests. `writeDataPoint` is
 * fire-and-forget: it returns `void` and never throws on the hot path.
 */
export interface AnalyticsEngineDatasetLike {
    writeDataPoint: (event: AnalyticsEngineDataPoint) => void;
}

/**
 * The value types Workers KV can store / return. Mirrors Cloudflare's
 * `KVNamespace` `get`/`put` body unions; declared here so the package stays
 * runtime-agnostic and the `*Like` interfaces don't pull in
 * `@cloudflare/workers-types` at runtime.
 */
export type KvValue = ReadableStream | ArrayBuffer | ArrayBufferView | string;

/** How a raw KV read should decode the stored value. Mirrors KV's `type` option. */
export type KvValueType = "text" | "json" | "arrayBuffer" | "stream";

/**
 * Per-read options forwarded to the binding. `cacheTtl` is KV's edge-cache TTL
 * (seconds, min 60); `type` selects the decode mode for `Kv.getRaw` (in `@lunora/bindings/kv`).
 */
export interface KvGetOptions {
    /** KV edge-cache TTL in seconds (minimum 60). Forwarded verbatim. */
    cacheTtl?: number;
    /** Decode mode for a raw read. `Kv.get` (in `@lunora/bindings/kv`) always uses `"json"`. */
    type?: KvValueType;
}

/**
 * Minimal projection of Cloudflare's `KVNamespace`. Declared structurally so
 * unit tests can pass a plain `Map`-backed double; the real binding satisfies
 * the same shape. Mirrors `R2BucketLike` in `@lunora/storage`.
 */
export interface KVNamespaceLike {
    /** Delete a key. No-op if the key is absent. */
    delete: (key: string) => Promise<void>;

    /**
     * Read a value. The real binding overloads on `options.type`; declared here
     * as the broad union so a structural double need only return the value (or
     * `null` when absent).
     */
    get: (key: string, options?: KvGetOptions | KvValueType) => Promise<unknown>;

    /**
     * Read a value together with its associated metadata. Returns
     * `{ value: null, metadata: null }` when the key is absent.
     */
    getWithMetadata: (key: string, options?: KvGetOptions | KvValueType) => Promise<{ metadata: unknown; value: unknown }>;

    /** List keys, optionally filtered by `prefix` and paginated via `cursor`. */
    list: (options?: { cursor?: string; limit?: number; prefix?: string }) => Promise<KvNamespaceListResult>;

    /** Write a value, optionally with TTL/expiration and metadata. */
    put: (key: string, value: KvValue, options?: KvNamespacePutOptions) => Promise<void>;
}

/** The raw put options the KV binding accepts (mirrors `KVNamespacePutOptions`). */
export interface KvNamespacePutOptions {
    /** Absolute expiration as a Unix timestamp (seconds). Mutually exclusive with `expirationTtl`. */
    expiration?: number;
    /** Relative expiration in seconds from now (minimum 60). Mutually exclusive with `expiration`. */
    expirationTtl?: number;
    /** Arbitrary JSON metadata stored alongside the value, returned by `getWithMetadata`/`list`. */
    metadata?: unknown;
}

/** One key entry as returned by the KV binding's `list`. */
export interface KvListKey<Metadata = unknown> {
    /** Absolute expiration (Unix seconds), when the key has one. */
    expiration?: number;
    /** The key's metadata, when set at write time. */
    metadata?: Metadata;
    /** The key name. */
    name: string;
}

/** The raw `list` result shape returned by the KV binding. */
export type KvNamespaceListResult<Metadata = unknown> =
    | { cacheStatus?: string | null; cursor: string; keys: KvListKey<Metadata>[]; list_complete: false }
    | { cacheStatus?: string | null; keys: KvListKey<Metadata>[]; list_complete: true };

/**
 * Minimal structural projection of `VectorizeIndex` so unit tests can pass a
 * plain-object double and the real Cloudflare binding satisfies the same shape.
 * Mirrors the surface documented at
 * https://developers.cloudflare.com/vectorize/reference/client-api/.
 */
export interface VectorizeIndexLike {
    deleteByIds: (ids: ReadonlyArray<string>) => Promise<VectorizeDeleteMutation>;
    describe?: () => Promise<VectorizeIndexDetails>;
    getByIds: (ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorizeVector>>;
    insert: (vectors: ReadonlyArray<VectorizeVector>) => Promise<VectorizeUpsertMutation>;
    query: (vector: ReadonlyArray<number>, options?: VectorizeQueryOptions) => Promise<VectorizeMatches>;
    upsert: (vectors: ReadonlyArray<VectorizeVector>) => Promise<VectorizeUpsertMutation>;
}

export type VectorMetric = "cosine" | "euclidean" | "dot-product";

export interface VectorizeVector {
    id: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
    values: ReadonlyArray<number>;
}

export interface VectorizeQueryOptions {
    filter?: Record<string, unknown>;
    namespace?: string;
    returnMetadata?: "none" | "indexed" | "all";
    returnValues?: boolean;
    topK?: number;
}

export interface VectorizeMatch {
    id: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
    score: number;
    values?: ReadonlyArray<number>;
}

export interface VectorizeMatches {
    count: number;
    matches: ReadonlyArray<VectorizeMatch>;
}

export interface VectorizeUpsertMutation {
    mutationId: string;
}

export interface VectorizeDeleteMutation {
    count?: number;
    mutationId: string;
}

export interface VectorizeIndexDetails {
    dimensions: number;
    processedUpToDatetime?: string;
    processedUpToMutation?: string;
    vectorsCount: number;
}

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
    // `startAfter` is in the real `R2Bucket.list` signature and was missing here
    // — the same projection drift this file's `put` comments call out. It is what
    // lets a caller resume a key-ordered scan from a known position instead of
    // paging from the start and discarding the prefix, so its absence turns an
    // indexed seek into a walk over every key ever written.
    // `include` is in the real `R2Bucket.list` signature and its absence here
    // meant nothing COULD ask for it: under `r2_list_honor_include` R2 leaves
    // `httpMetadata`/`customMetadata` off every list entry unless the option
    // names them, so a caller reading them off a list got empty objects while
    // `head()` on the same key returned them.
    list: (options?: {
        cursor?: string;
        delimiter?: string;
        // Mutable, not `ReadonlyArray`: R2's own `R2ListOptions` declares it that
        // way, and a readonly parameter type is not assignable to it.
        include?: ("customMetadata" | "httpMetadata")[];
        limit?: number;
        prefix?: string;
        startAfter?: string;
    }) => Promise<{
        cursor?: string;
        // The common-prefix roll-up R2 returns when `delimiter` is set. Without
        // it a delimited list is lossy in the one case it exists for: every key
        // under the delimiter lands here rather than in `objects`, so a caller
        // that only reads `objects` sees an empty, untruncated page and renders
        // an empty folder over a full bucket.
        delimitedPrefixes?: string[];
        objects: R2ObjectLike[];
        truncated?: boolean;
    }>;
    put: (
        key: string,
        // `ArrayBufferView` is in the real `R2Bucket.put` signature and in this
        // file's own `uploadPart`; it was missing here, which is the projection
        // drifting from the binding it projects. A `Uint8Array` is the most
        // natural thing to hand a byte store.
        body: ReadableStream | ArrayBuffer | ArrayBufferView | Blob | string | null,
        // `sha256` is in the real `R2Bucket.put` signature and `@lunora/storage`'s
        // `upload` has always passed it; the projection omitted it, which is the
        // drift this file exists to prevent. R2 verifies the digest on write and
        // records it, and a recorded digest is the only reason `list()`/`head()`
        // can report `checksums.sha256` at all.
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; sha256?: ArrayBuffer | string },
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

    /**
     * The quoted form of {@link R2ObjectLike.etag} (e.g. `"abc123"`), suitable
     * for emitting directly as an HTTP `ETag` header. The real binding always
     * provides it; declared optional so existing doubles that only set `etag`
     * still type-check (callers fall back to quoting `etag`).
     */
    httpEtag?: string;
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

/** How a queue message body is serialized on the wire (Cloudflare default `"json"`). */
export type QueueContentType = "bytes" | "json" | "text" | "v8";

/** Options for a single `producer.send(body, options?)`. */
export interface QueueSendOptions {
    /** Wire serialization for this message (defaults to the queue's content type). */
    contentType?: QueueContentType;
    /** Per-message delivery delay in seconds (0–43200, i.e. up to 12 hours). */
    delaySeconds?: number;
}

/** Options for a `producer.sendBatch(messages, options?)`. */
export interface QueueSendBatchOptions {
    /** Delivery delay applied to the whole batch, in seconds. */
    delaySeconds?: number;
}

/** One entry in a `sendBatch` call — a body plus optional per-message overrides. */
export interface MessageSendRequestLike<Body = unknown> {
    body: Body;
    contentType?: QueueContentType;
    delaySeconds?: number;
}

/**
 * Minimal structural projection of workers-types' `Queue<Body>` (the producer
 * binding). The real binding's `send`/`sendBatch` resolve to a metadata object;
 * we widen the return to `Promise<unknown>` so a plain-object fake satisfies it.
 */
export interface QueueBindingLike<Body = unknown> {
    send: (message: Body, options?: QueueSendOptions) => Promise<unknown>;
    sendBatch: (messages: Iterable<MessageSendRequestLike<Body>>, options?: QueueSendBatchOptions) => Promise<unknown>;
}

/** Structural mirror of workers-types' `Message<Body>` (one delivered message). */
export interface MessageLike<Body = unknown> {
    /** Acknowledge this message so it is not redelivered. */
    ack: () => void;
    readonly attempts: number;
    readonly body: Body;
    readonly id: string;
    /** Explicitly retry this message (optionally after a delay). */
    retry: (options?: QueueRetryOptions) => void;
    readonly timestamp: Date;
}

/** Structural mirror of workers-types' `MessageBatch<Body>` handed to a consumer. */
export interface MessageBatchLike<Body = unknown> {
    /** Acknowledge every message in the batch. */
    ackAll: () => void;
    readonly messages: ReadonlyArray<MessageLike<Body>>;
    /** The queue name this batch was delivered from (`batch.queue`), used to route. */
    readonly queue: string;
    /** Retry every message in the batch (optionally after a delay). */
    retryAll: (options?: QueueRetryOptions) => void;
}

/** Options for retrying a message / batch (`message.retry({ delaySeconds })`). */
export interface QueueRetryOptions {
    delaySeconds?: number;
}
