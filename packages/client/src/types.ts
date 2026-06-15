/** The registered function kinds a {@link FunctionReference} can describe. `stream` is a query that yields multiple frames over the WS. */
export type FunctionKind = "action" | "mutation" | "query" | "stream";

/**
 * Opaque reference to a registered function emitted by `@lunora/codegen`.
 *
 * At runtime it carries the `&lt;file>:&lt;function>` identifier in `__lunoraRef`.
 * Generated declarations decorate this with phantom type parameters so the
 * client can infer args / return values per call site.
 */
export interface FunctionReference<Kind extends FunctionKind = FunctionKind, Args = unknown, Return = unknown> {
    /**
     * Phantom marker carrying the `Kind`/`Args`/`Return` type parameters for
     * inference. Never present at runtime; declared as a covariant (output)
     * position so a concrete reference stays assignable to a widened one.
     */
    readonly __lunoraPhantom?: { args: Args; kind: Kind; returns: Return };
    readonly __lunoraRef: string;
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
    readonly __lunoraPreloaded: true;
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

/** Which durable-storage operation failed, passed to {@link OfflineQueueOptions.onPersistenceError}. */
export type PersistenceOperation = "append" | "clear" | "load" | "remove";

/** Context handed to a persistence-error handler. */
export interface PersistenceErrorContext {
    readonly error: unknown;
    /** The mutation id involved, when the failing op was scoped to one (`append`/`remove`). */
    readonly mutationId?: string;
    readonly operation: PersistenceOperation;
}

export interface OfflineQueueOptions {
    maxItems?: number;

    /**
     * Invoked when a {@link PersistenceAdapter} call rejects (e.g. IndexedDB quota
     * exceeded). Without a handler, failures are logged via `console.warn` so they
     * are never fully silent. Note: a failed `append` means the write is queued in
     * memory but NOT durable — it will not survive a reload.
     */
    onPersistenceError?: (context: PersistenceErrorContext) => void;

    /**
     * Queue mutations issued before a shard's first successful WebSocket
     * connect (defaults to `false`). The standard behaviour (`LunoraClient`'s
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

    /**
     * Issuing identity fingerprint, persisted so a hydrated write replays only
     * under the identity that queued it (`null` = queued while signed out).
     * Absent on records written by older client versions, which replay under
     * the ambient identity for back-compat.
     */
    identity?: string | null;
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

/**
 * One persisted query result in the durable read cache (Pillar 2). Keyed in the
 * store by `shardKey + functionPath + argsKey`; the record carries everything
 * needed to render offline on reload and to resume the live subscription.
 */
export interface CachedQuery {
    /**
     * Issuing identity fingerprint (same shape the offline queue stamps). A
     * cached value only hydrates when it matches the current identity, so a
     * signed-out cache never leaks into a new session. `null` = cached while
     * signed out.
     */
    identity: string | null;

    /**
     * The `cursor` high-watermark this value reflects, replayed as `sinceSeq`
     * on reconnect so the server can resume instead of re-snapshotting. Absent
     * when the value predates CDC / no cursor was advertised.
     */
    serverCursor?: number;

    /** Wall-clock millis the value was written — drives LRU eviction. */
    ts: number;

    /** The full query result last seen from the server. */
    value: unknown;
}

/**
 * Durable store for the client read cache (Pillar 2): query results survive a
 * reload so reads hydrate from disk and render immediately while the socket
 * reconnects. Opt-in via {@link LunoraClientOptions.queryCache}; omit to keep
 * reads in memory only (today's behaviour). Mirrors {@link PersistenceAdapter}'s
 * shape over the same IndexedDB plumbing.
 */
export interface QueryCacheAdapter {
    /** Drop every cached query (e.g. on logout / identity change). */
    clear: () => Promise<void>;
    /** Load every cached query — called once at startup to hydrate reads. */
    load: () => Promise<(CachedQuery & { key: string })[]>;
    /** Upsert one cached query by key (called when a subscription value advances). */
    put: (key: string, entry: CachedQuery) => Promise<void>;
    /** Remove one cached query by key. */
    remove: (key: string) => Promise<void>;
}

export interface LunoraClientOptions {
    /**
     * Base path the worker mounts better-auth at, used by the client's
     * `getCurrentUser()` to reach the `get-session` route. Defaults to
     * `/api/auth` (matching `@lunora/auth`'s `DEFAULT_AUTH_BASE_PATH`).
     */
    authBasePath?: string;
    bookmarkStorage?: BookmarkStorage;

    /**
     * Default app context sent in the `connect` envelope right after each socket
     * opens, forwarded to the server's `onConnect`/`onDisconnect` lifecycle hooks
     * as `event.context`. A per-shard context registered via
     * `setConnectionContext` overrides this for that shard. Omit when no lifecycle
     * hook needs connection context.
     */
    connectionContext?: Record<string, unknown>;
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

    /**
     * Durable store for the read cache (Pillar 2). When supplied, query results
     * are persisted as their subscriptions advance and hydrated on construction
     * so a reload renders cached data before the socket reconnects, then resumes
     * the live subscription from the persisted cursor. Omit (or pass `false`) to
     * keep reads in memory only — the default, unchanged behaviour.
     */
    queryCache?: QueryCacheAdapter | false;
    reconnect?: ReconnectOptions;
    url: string;
    WebSocket?: typeof WebSocket;

    /**
     * Token appended to the WebSocket URL as `?token=…`. The server matches it
     * against `LUNORA_WS_BEARER` (to clear the upgrade gate) and/or
     * `LUNORA_ADMIN_TOKEN` (to authorize `__lunora_admin__:*` subscriptions —
     * what the studio sets it to). Browsers can't set headers on the
     * `WebSocket` constructor, so the query parameter is the only channel; it
     * ends up in server logs and history, so prefer a short-lived rotating
     * token in production.
     */
    wsToken?: string;
    wsUrl?: string;
}

/** Wire envelope sent on `POST /_lunora/rpc`. */
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

    /**
     * `sinceSeq` is the persisted `cursor` high-watermark the client last saw
     * for this shard (Pillar 1b resume). Present only when a durable
     * {@link QueryCacheAdapter} restored a cached value with a cursor; the
     * server replies with a lightweight `resume` frame instead of a full
     * snapshot when nothing the query reads changed since it. Absent on a
     * first-time subscribe.
     */
    query: { args?: Record<string, unknown>; functionPath?: string; sinceSeq?: number; table?: string };
    type: "subscribe";
}

export interface ClientUnsubscribeMessage {
    id: string;
    type: "unsubscribe";
}

/**
 * One-shot control frame sent right after the socket opens. Registers the
 * connection's app `context` (e.g. `{ roomId, sessionId }`) with the server and
 * fires the `onConnect` lifecycle hooks; the same context is replayed to
 * `onDisconnect` when the socket drops.
 */
export interface ClientConnectMessage {
    context?: Record<string, unknown>;
    id: string;
    type: "connect";
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

export type ClientMessage = ClientAckMessage | ClientConnectMessage | ClientStreamMessage | ClientSubscribeMessage | ClientUnsubscribeMessage;

/** Subscription protocol — server → client. */
export interface ServerDataMessage {
    /**
     * The `__cdc_log` high-watermark covered by this frame (Pillar 1b). The
     * client persists it as the query's `serverCursor` and replays it as
     * `sinceSeq` on the next reconnect. Absent on shards that never enabled CDC.
     */
    cursor?: number;
    data?: unknown;
    delta?: unknown;
    id: string;
    type: "data" | "delta";
}

/**
 * Lightweight resume acknowledgement (Pillar 1b): the server determined that
 * nothing the subscription reads changed since the client's `sinceSeq`, so it
 * skips re-sending the snapshot. The client keeps its cached value and only
 * advances `serverCursor` to `cursor`.
 */
export interface ServerResumeMessage {
    cursor?: number;
    id: string;
    type: "resume";
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

export type ServerMessage = ServerAckMessage | ServerChunkMessage | ServerCompleteMessage | ServerDataMessage | ServerErrorMessage | ServerResumeMessage;

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
 * `GET /_lunora/admin/scheduled` endpoint. Mirrors `@lunora/scheduler`'s
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
 * `GET /_lunora/admin/scheduled/status` endpoint. Mirrors `@lunora/scheduler`'s
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
 * `GET /_lunora/admin/scheduled/status` endpoint. `pools` is the per-pool
 * breakdown; `backlog` and `inFlight` are the app-wide sums of `queued` and
 * `inFlight` across every pool — the headline numbers for the studio SLO
 * view. Mirrors `@lunora/scheduler`'s `SchedulerStatus` structurally.
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
 * One shard's request volume, as returned by the worker's
 * `POST /_lunora/admin/shard-traffic` endpoint. The cross-shard traffic feed
 * the studio's `hot_shard` advisor lint consumes: `requests` is the shard's
 * lifetime dispatch total, `shardKey` the DO id name (`""` for the root shard).
 */
export interface ShardTrafficEntry {
    requests: number;
    shardKey: string;
}

/**
 * The whole-shard-set traffic distribution returned by the worker's
 * `POST /_lunora/admin/shard-traffic` endpoint. `shards` is one entry per live
 * shard (a failed shard surfaces with `requests: 0`); `ok`/`failed` count the
 * shards that returned vs. errored. Shaped to feed the advisor's `hot_shard`
 * lint after the studio tags each entry with its sharded function `group`.
 */
export interface ShardTrafficResult {
    failed: number;
    ok: number;
    shards: ShardTrafficEntry[];
}

/**
 * One object in the storage bucket, as returned by the worker's
 * `GET /_lunora/admin/storage` endpoint. Mirrors `@lunora/storage`'s
 * `R2ObjectLike` structurally.
 */
export interface StorageObject {
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    size: number;

    /**
     * When the object was stored. R2 emits a `Date`, which JSON-serializes to an
     * ISO string over the wire; a mock may supply epoch ms — so consumers should
     * normalise via `new Date(uploaded)`. Absent if the backend didn't report it.
     */
    uploaded?: number | string;
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
 * `GET /_lunora/admin/functions` endpoint: its `&lt;file>:&lt;function>` path, which
 * client method (`query` / `mutation` / `action`) invokes it, and its argument
 * signature. `args` is absent on responses from an older worker.
 */
export interface FunctionDescriptor {
    args?: FunctionArgumentDescriptor[];
    kind: "action" | "mutation" | "query";
    path: string;
}

/**
 * One code-defined cron trigger, as returned by the worker's
 * `GET /_lunora/admin/cron-jobs` endpoint: the `cron` expression that fires it,
 * the `&lt;file>:&lt;function>` path it invokes, its human `name`, and any bound
 * `args` / `shardKey`. Static for the deployment (Cloudflare exposes no runtime
 * cron introspection), so the studio renders these read-only.
 */
// The admin wire-shape types `CronJobInfo` (cron-triggers tab), `VectorIndexSummary`
// + `VectorQueryMatch` (vector browser) are owned by the runtime contract
// (`@lunora/runtime`, which defines the `/_lunora/admin/*` endpoints) and
// re-exported here for SDK consumers — a single source of truth, no hand-kept
// copies to drift. Type-only re-export, so no worker code reaches the browser SDK.
export type { CronJobInfo, VectorIndexSummary, VectorQueryMatch } from "@lunora/runtime";

/** A `.global()` (D1-backed) table plus its row count, from `/_lunora/admin/global/tables`. */
export interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one global table, from `/_lunora/admin/global/table`. */
export interface GlobalTablePage {
    columns: string[];
    /** FK columns (local column → referenced table) for external tables with real `REFERENCES` constraints, from `PRAGMA foreign_key_list`. */
    refs?: Record<string, string>;
    rows: Record<string, unknown>[];
    total: number;
}

/**
 * One equality constraint a facet-value click adds to the global browser's view
 * (`column = value`). `value` is the raw stored scalar the facet returned, sent
 * as-is and bound server-side, so it never injects SQL.
 */
export interface GlobalFilterClause {
    column: string;
    value: unknown;
}

/** One distinct value of a faceted global column with its row count, from `/_lunora/admin/global/facet`. */
export interface GlobalFacetValue {
    count: number;
    value: unknown;
}

/** Per-column distinct-value summary for the global browser, from `/_lunora/admin/global/facet`. */
export interface GlobalFacetResult {
    truncated: boolean;
    values: GlobalFacetValue[];
}

/** A nullable timestamp field as better-auth serializes it: epoch-ms, ISO string, or null. */
export type NullableTimestamp = null | number | string;

// The auth wire-shape types (`AuthUser`/`AuthSession`/`AuthPage`/`AuthImpersonation`/
// `AuthCapabilities`) are owned by the runtime contract (`@lunora/runtime`, the
// package that defines the `/_lunora/admin/auth/*` endpoints) and re-exported here
// for SDK consumers — a single source of truth, no hand-kept copies. This is a
// type-only re-export, so no runtime/worker code is pulled into the browser SDK.
export type { AuthCapabilities, AuthImpersonation, AuthPage, AuthSession, AuthUser } from "@lunora/runtime";
