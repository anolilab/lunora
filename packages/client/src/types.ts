/** The registered function kinds a {@link FunctionReference} can describe. `stream` is a query that yields multiple frames over the WS. */
export type FunctionKind = "action" | "mutation" | "query" | "stream";

/**
 * Opaque reference to a registered function emitted by `@cirrus/codegen`.
 *
 * At runtime it carries the `&lt;file>:&lt;function>` identifier in `__cirrusRef`.
 * Generated declarations decorate this with phantom type parameters so the
 * client can infer args / return values per call site.
 */
export interface FunctionReference<Kind extends FunctionKind = FunctionKind, Args = unknown, Return = unknown> {
    /**
     * Phantom marker carrying the `Kind`/`Args`/`Return` type parameters for
     * inference. Never present at runtime; declared as a covariant (output)
     * position so a concrete reference stays assignable to a widened one.
     */
    readonly __cirrusPhantom?: { args: Args; kind: Kind; returns: Return };
    readonly __cirrusRef: string;
}

/** Extract the args type from a {@link FunctionReference}. */
export type ArgsOf<F> = F extends FunctionReference<infer _K, infer A, infer _R> ? A : never;

/** Extract the return type from a {@link FunctionReference}. */
export type ReturnOf<F> = F extends FunctionReference<infer _K, infer _A, infer R> ? R : never;

export type Unsubscribe = () => void;

/**
 * Serializable result of `preloadQuery`. Produced on the server during SSR,
 * embedded in the rendered HTML, then handed to `usePreloadedQuery` on the
 * client so the first render shows the server value with no loading flash
 * before a live subscription attaches. Every field survives `JSON.stringify`.
 */
export interface Preloaded<T = unknown> {
    readonly __cirrusPreloaded: true;
    readonly args: Record<string, unknown>;
    readonly functionPath: string;
    readonly shardKey?: string;
    readonly value: T;
}

/**
 * Pluggable storage for the `x-d1-bookmark` value used to provide
 * read-your-writes between a mutation and subsequent queries.
 */
export interface BookmarkStorage {
    get: () => string | null;
    set: (value: string | null) => void;
}

export interface ReconnectOptions {
    initialDelayMs?: number;
    jitter?: boolean;
    maxDelayMs?: number;
}

export interface OfflineQueueOptions {
    maxItems?: number;

    /**
     * Queue mutations issued before a shard's first successful WebSocket
     * connect (defaults to `false`). The standard behaviour (`CirrusClient`'s
     * `mutation()`) queues only when the targeted shard has been connected at
     * least once (`wasEverConnected`), so the registry / resubscribe handshake
     * has run. Set this to `true` for offline-first apps that want to enqueue
     * writes on the very first session before the WS is up.
     */
    queueBeforeFirstConnect?: boolean;
}

/**
 * Serializable shape of an offline mutation, durably stored by a
 * {@link PersistenceAdapter} so queued writes survive a reload/crash. The live
 * `resolve`/`reject` callbacks of an in-flight `QueuedMutation` are *not*
 * persisted — a restored mutation is replayed with no original awaiter.
 */
export interface PersistedMutation {
    args: Record<string, unknown>;
    functionPath: string;
    id: string;
    shardKey?: string;
}

/**
 * Durable store for the offline mutation queue. The default client keeps the
 * queue in memory; supplying an adapter (e.g. `createIndexedDbPersistence`)
 * makes queued writes survive a page reload. Implementations must preserve FIFO
 * (enqueue) order in `PersistenceAdapter.load`.
 *
 * Replay semantics are at-least-once: a mutation is removed only after the
 * server confirms (or rejects) it, so a crash between commit and `remove` can
 * replay it again on the next load.
 */
export interface PersistenceAdapter {
    /** Append a mutation to durable storage (called on enqueue). */
    append: (mutation: PersistedMutation) => Promise<void>;
    /** Drop every persisted mutation (e.g. on logout). */
    clear: () => Promise<void>;
    /** Load all persisted mutations in FIFO order — called once at startup. */
    load: () => Promise<PersistedMutation[]>;
    /** Remove a mutation by id once it has been replayed (resolved or rejected). */
    remove: (id: string) => Promise<void>;
}

export interface CirrusClientOptions {
    /**
     * Base path the worker mounts better-auth at, used by the client's
     * `getCurrentUser()` to reach the `get-session` route. Defaults to
     * `/api/auth` (matching `@cirrus/auth`'s `DEFAULT_AUTH_BASE_PATH`).
     */
    authBasePath?: string;
    bookmarkStorage?: BookmarkStorage;
    fetch?: typeof fetch;

    /**
     * Interval (ms) between keepalive pings sent on each open subscription
     * socket. The server answers them via the Durable Object's hibernation
     * auto-response WITHOUT waking the DO, so an idle socket stays alive across
     * hibernation without a billable wakeup. Defaults to 30000 (30s); set to
     * `0` (or a negative value) to disable the heartbeat entirely.
     */
    heartbeatIntervalMs?: number;
    offlineQueue?: OfflineQueueOptions;
    /** Durable store for the offline mutation queue; omit to keep it in memory. */
    persistence?: PersistenceAdapter;
    reconnect?: ReconnectOptions;
    url: string;
    WebSocket?: typeof WebSocket;

    /**
     * Token appended to the WebSocket URL as `?token=…`. The server matches it
     * against `CIRRUS_WS_BEARER` (to clear the upgrade gate) and/or
     * `CIRRUS_ADMIN_TOKEN` (to authorize `__cirrus_admin__:*` subscriptions —
     * what the studio sets it to). Browsers can't set headers on the
     * `WebSocket` constructor, so the query parameter is the only channel; it
     * ends up in server logs and history, so prefer a short-lived rotating
     * token in production.
     */
    wsToken?: string;
    wsUrl?: string;
}

/** Wire envelope sent on `POST /_cirrus/rpc`. */
export interface RpcEnvelope {
    args?: Record<string, unknown>;
    functionPath: string;
    shardKey?: string;
}

/** Wire response from the shard's `/rpc` endpoint (forwarded by the runtime). */
export type RpcResponseBody = { result: unknown } | { error: { code: string; message: string } };

/** Subscription protocol — client → server. */
export interface ClientSubscribeMessage {
    id: string;
    query: { args?: Record<string, unknown>; functionPath?: string; table?: string };
    type: "subscribe";
}

export interface ClientUnsubscribeMessage {
    id: string;
    type: "unsubscribe";
}

export interface ClientAckMessage {
    id: string;
    type: "ack";
}

/**
 * Start a streaming query. The id namespaces a fresh stream and is echoed on
 * every {@link ServerChunkMessage} the server pushes back. Cancel a running
 * stream by sending a {@link ClientUnsubscribeMessage} with the same id —
 * subscription and stream id-spaces share the cancel channel; the prefix
 * (`sub_*` vs `stream_*`) keeps the local registries searchable.
 */
export interface ClientStreamMessage {
    id: string;
    query: { args?: Record<string, unknown>; functionPath: string; shardKey?: string };
    type: "stream";
}

export type ClientMessage = ClientAckMessage | ClientStreamMessage | ClientSubscribeMessage | ClientUnsubscribeMessage;

/** Subscription protocol — server → client. */
export interface ServerDataMessage {
    data?: unknown;
    delta?: unknown;
    id: string;
    type: "data" | "delta";
}

export interface ServerErrorMessage {
    error?: unknown;
    id?: string;
    message?: string;
    type: "error";
}

export interface ServerAckMessage {
    id: string;
    type: "ack";
}

export interface ServerCompleteMessage {
    id: string;
    type: "complete";
}

/** One frame of a streaming query — `data` carries the user-yielded chunk. */
export interface ServerChunkMessage {
    data: unknown;
    id: string;
    type: "chunk";
}

export type ServerMessage = ServerAckMessage | ServerChunkMessage | ServerCompleteMessage | ServerDataMessage | ServerErrorMessage;

/**
 * The authenticated user as exposed client-side, mirroring better-auth's
 * `user` row (the `user` field of the `get-session` response). Kept minimal
 * and structural — only `id` is guaranteed; the rest are the common better-auth
 * fields, and the index signature carries any plugin-contributed extras.
 */
export interface User {
    readonly createdAt?: NullableTimestamp;
    readonly email?: null | string;
    readonly emailVerified?: boolean | null;
    readonly id: string;
    readonly image?: null | string;
    readonly name?: null | string;
    readonly [key: string]: unknown;
    readonly updatedAt?: NullableTimestamp;
}

/**
 * One pending scheduled function, as returned by the worker's
 * `GET /_cirrus/admin/scheduled` endpoint. Mirrors `@cirrus/scheduler`'s
 * `ScheduleRecord` structurally so the client carries no dependency on it.
 */
export interface ScheduleRecord {
    args: Record<string, unknown>;
    enqueuedAt: number;
    functionPath: string;
    id: string;
    scheduledFor: number;
    shardKey?: string;
}

/**
 * One workpool's live backlog, as returned by the worker's
 * `GET /_cirrus/admin/scheduled/status` endpoint. Mirrors `@cirrus/scheduler`'s
 * `SchedulerPoolStatus` structurally so the client carries no dependency on it.
 */
export interface SchedulerPoolStatus {
    /** Jobs currently dispatched-but-not-yet-completed (the held concurrency slots). */
    inFlight: number;
    /** The pool's concurrency cap. */
    maxConcurrency: number;
    /** The logical workpool name. */
    name: string;
    /** Pending jobs routed to this pool but not yet dispatched. */
    queued: number;
}

/**
 * The app-level scheduler backlog, as returned by the worker's
 * `GET /_cirrus/admin/scheduled/status` endpoint. `pools` is the per-pool
 * breakdown; `backlog` and `inFlight` are the app-wide sums of `queued` and
 * `inFlight` across every pool — the headline numbers for the studio SLO
 * view. Mirrors `@cirrus/scheduler`'s `SchedulerStatus` structurally.
 */
export interface SchedulerStatus {
    /** Sum of every pool's `queued` count — the total pending backlog. */
    backlog: number;
    /** Sum of every pool's `inFlight` count — the total held concurrency slots. */
    inFlight: number;
    /** Per-pool backlog breakdown. */
    pools: SchedulerPoolStatus[];
}

/**
 * One object in the storage bucket, as returned by the worker's
 * `GET /_cirrus/admin/storage` endpoint. Mirrors `@cirrus/storage`'s
 * `R2ObjectLike` structurally.
 */
export interface StorageObject {
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    size: number;
}

/** One page of {@link StorageObject}s plus the cursor to fetch the next, if any. */
export interface StorageListPage {
    cursor?: string;
    objects: StorageObject[];
}

/**
 * One argument of a registered function, derived from its `v.*` validator by the
 * worker. A compact signature shape — enough to render a function's API without
 * the build-time codegen types.
 */
export interface FunctionArgumentDescriptor {
    /** Element validator kind for an `array` arg (one level), e.g. `string`. */
    element?: string;
    /** The (optional-unwrapped) validator kind, e.g. `string`, `id`, `object`. */
    kind: string;
    /** The argument name. */
    name: string;
    /** True when the arg is wrapped in `v.optional(...)`. */
    optional: boolean;
    /** Target table for an `id` arg (`v.id("table")`). */
    table?: string;
}

/**
 * One registered function, as returned by the worker's
 * `GET /_cirrus/admin/functions` endpoint: its `&lt;file>:&lt;function>` path, which
 * client method (`query` / `mutation` / `action`) invokes it, and its argument
 * signature. `args` is absent on responses from an older worker.
 */
export interface FunctionDescriptor {
    args?: FunctionArgumentDescriptor[];
    kind: "action" | "mutation" | "query";
    path: string;
}

/** A `.global()` (D1-backed) table plus its row count, from `/_cirrus/admin/global/tables`. */
export interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one global table, from `/_cirrus/admin/global/table`. */
export interface GlobalTablePage {
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
}

/** A nullable timestamp field as better-auth serializes it: epoch-ms, ISO string, or null. */
export type NullableTimestamp = null | number | string;

/** One authenticated user, from `GET /_cirrus/admin/auth/users`. Mirrors better-auth's `user` row. */
export interface AuthUser {
    [key: string]: unknown;
    createdAt?: NullableTimestamp;
    email?: null | string;
    emailVerified?: boolean | null;
    id: string;
    image?: null | string;
    name?: null | string;
}

/** One auth session, from `GET /_cirrus/admin/auth/sessions`. Mirrors better-auth's `session` row. */
export interface AuthSession {
    [key: string]: unknown;
    createdAt?: NullableTimestamp;
    expiresAt?: NullableTimestamp;
    id: string;
    ipAddress?: null | string;
    userAgent?: null | string;
    userId: string;
}

/** A page of users or sessions plus the total count. */
export interface AuthPage<T> {
    rows: T[];
    total: number;
}
