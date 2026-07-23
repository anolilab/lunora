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

/**
 * Canonical subset of a KV namespace binding. Mirrors
 * `@lunora/bindings/kv`'s `KVNamespaceLike`.
 */
export interface KVNamespaceLike {
    delete: (key: string) => Promise<void>;
    get: (key: string, options?: { cacheTtl?: number; type?: "text" | "json" | "arrayBuffer" | "stream" }) => Promise<unknown>;
    getWithMetadata?: (
        key: string,
        options?: { cacheTtl?: number; type?: "text" | "json" | "arrayBuffer" | "stream" },
    ) => Promise<{ metadata: unknown; value: unknown }>;
    list: (options?: {
        cursor?: string;
        limit?: number;
        prefix?: string;
    }) => Promise<{ cursor?: string; keys: { expiration?: number; metadata?: unknown; name: string }[]; list_complete: boolean }>;
    put: (
        key: string,
        value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
        options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
    ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// R2 / Object storage
// ---------------------------------------------------------------------------

/** R2 object metadata. Mirrors `@lunora/storage`'s `R2ObjectLike`. */
export interface R2ObjectLike {
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    size: number;
    uploaded: Date;
}

/** R2 object with body. Mirrors `@lunora/storage`'s `R2ObjectBodyLike`. */
export interface R2ObjectBodyLike extends R2ObjectLike {
    arrayBuffer: () => Promise<ArrayBuffer>;
    body: ReadableStream;
    json: <T = unknown>() => Promise<T>;
    text: () => Promise<string>;
}

/**
 * Canonical subset of an R2 bucket binding. Mirrors `@lunora/storage`'s
 * `R2BucketLike`.
 */
export interface R2BucketLike {
    delete: (keys: string | string[]) => Promise<void>;
    get: (key: string, options?: { range?: { length?: number; offset?: number } | { suffix?: number } }) => Promise<R2ObjectBodyLike | null>;
    head?: (key: string) => Promise<R2ObjectLike | null>;
    list: (options?: { cursor?: string; limit?: number; prefix?: string }) => Promise<{ cursor?: string; objects: R2ObjectLike[]; truncated: boolean }>;
    put: (
        key: string,
        value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) => Promise<R2ObjectLike>;
}

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

/**
 * Canonical producer side of a queue binding. Mirrors
 * `@lunora/queue`'s `QueueBindingLike` and `@lunora/scheduler`'s `QueueLike`.
 */
export interface QueueBindingLike<Body = unknown> {
    send: (body: Body, options?: QueueSendOptionsLike) => Promise<void>;
    sendBatch: (messages: Iterable<QueueSendRequestLike<Body>>, options?: QueueSendOptionsLike) => Promise<void>;
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

/** A batch of messages handed to a queue consumer. */
export interface MessageBatchLike<Body = unknown> {
    ackAll: () => void;
    readonly messages: ReadonlyArray<QueueMessageLike<Body>>;
    readonly queue: string;
    retryAll: (options?: { delaySeconds?: number }) => void;
}

// ---------------------------------------------------------------------------
// D1 / relational database
// ---------------------------------------------------------------------------

/** D1 prepared statement. Mirrors `@lunora/d1`'s `D1PreparedStatementLike`. */
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

/** D1 session (read-your-writes bookmark). Mirrors `@lunora/d1`'s `D1SessionLike`. */
export interface D1SessionLike {
    batch: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
    getBookmark?: () => string | null;
    prepare: (query: string) => D1PreparedStatementLike;
}

/**
 * Canonical subset of a D1 database binding. Mirrors `@lunora/d1`'s
 * `D1DatabaseLike`.
 */
export interface D1DatabaseLike {
    batch: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
    exec?: (query: string) => Promise<unknown>;
    prepare: (query: string) => D1PreparedStatementLike;
    withSession?: (bookmark?: string) => D1SessionLike;
}

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

/**
 * Canonical subset of a Vectorize index binding. Mirrors
 * `@lunora/bindings/vectors`'s `VectorizeIndexLike`.
 */
export interface VectorizeIndexLike {
    deleteByIds?: (ids: string[]) => Promise<{ count: number }>;
    describe?: () => Promise<{ dimensions: number; vectorsCount?: number }>;
    getByIds?: (ids: string[]) => Promise<VectorRecordLike[]>;
    query: (
        vector: number[],
        options?: { filter?: Record<string, unknown>; namespace?: string; returnMetadata?: boolean | "all" | "indexed" | "none"; topK?: number },
    ) => Promise<{ matches: VectorMatchLike[] }>;
    upsert: (vectors: VectorRecordLike[]) => Promise<{ count: number; ids?: string[] }>;
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

/**
 * Canonical subset of an Analytics Engine dataset binding. Mirrors
 * `@lunora/bindings/analytics`'s `AnalyticsEngineDatasetLike`.
 */
export interface AnalyticsEngineDatasetLike {
    writeDataPoint: (event: AnalyticsEngineDataPointLike) => void;
}
