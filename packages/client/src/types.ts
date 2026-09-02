import type { FunctionReference } from "../../../shared/function-reference";

export type { ArgsOf, FunctionKind, FunctionReference, ReturnOf } from "../../../shared/function-reference";

/**
 * Typed reference to an HTTP-SSE stream route (`httpRoute.<verb>(path).stream()`)
 * emitted by `@lunora/codegen` as `httpStreams.<namespace>.<name>`.
 *
 * Distinct from {@link FunctionReference}: this is the **HTTP-SSE route stream**
 * (opened with `fetch` + `ReadableStream` against the route's own URL), not the
 * WS procedure stream (`kind: "stream"`). At runtime it carries the HTTP verb
 * and the route path; the phantom marker carries the chunk / searchParams /
 * params types so `httpStream` (and the framework hooks over it) infer the
 * chunk type end-to-end.
 * @experimental Reconnect/POST-body/wire-fidelity design questions are still open, so the shape may change.
 */
export interface HttpStreamRef<Chunk = unknown, SearchParams = unknown, Params = unknown> {
    /**
     * Phantom marker carrying the `Chunk`/`SearchParams`/`Params` type
     * parameters for inference. Never present at runtime; declared in a
     * covariant (output) position so a concrete reference stays assignable to
     * a widened one.
     */
    readonly __lunoraHttpStream?: { chunk: Chunk; params: Params; searchParams: SearchParams };
    /** HTTP verb the route binds to (uppercased), e.g. `"GET"`. */
    readonly method: string;
    /** The route path as declared, e.g. `/api/tokens/:id` — `:name` segments are filled from `params`. */
    readonly path: string;
}

/**
 * The call-side args of an HTTP-SSE stream route: `:name` path params plus URL query params.
 * @experimental Part of the HTTP-SSE stream surface.
 */
export interface HttpStreamCallArgs<SearchParams = unknown, Params = unknown> {
    /** Values for the route path's `:name` segments. */
    params?: Params;
    /** URL query params, appended to the request URL (undefined entries are skipped). */
    searchParams?: SearchParams;
}

/**
 * Extract the chunk type from a {@link HttpStreamRef}.
 * @experimental Part of the HTTP-SSE stream surface.
 */
export type HttpStreamChunkOf<R> = R extends HttpStreamRef<infer Chunk, infer _S, infer _P> ? Chunk : never;

/**
 * Extract the call-side args type from a {@link HttpStreamRef}.
 * @experimental Part of the HTTP-SSE stream surface.
 */
export type HttpStreamArgsOf<R> = R extends HttpStreamRef<infer _C, infer S, infer P> ? HttpStreamCallArgs<S, P> : never;

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

    /**
     * The client id that queued this write, persisted so a replay after a reload
     * lands in the SAME server-side dedup namespace it was issued under. The
     * standalone client's own `clientId` is minted per session, so replaying under
     * the live one would miss the `__idempotency` row for an anonymous caller and
     * re-run a write the server already committed. Absent on records written by
     * older client versions, which replay under the live id.
     */
    clientId?: string;
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

    /**
     * App/schema version stamped at enqueue (from `LunoraClientOptions.persistenceVersion`).
     * On hydrate, a record whose `version` doesn't match the current one is dropped
     * and purged rather than replayed — so a write persisted by an older deploy
     * (with a now-changed function signature) can't replay against the new schema.
     * Absent when no `persistenceVersion` is configured (no version gating).
     */
    version?: string;
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
 * One write handed to an {@link OutboxSink}. Mirrors {@link PersistedMutation}
 * plus the custom-mutator identity (`clientId`/`mutationId`/`idempotencyKey`)
 * the durable outbox needs to dedupe and watermark replays.
 */
export interface OutboxMutation {
    args: Record<string, unknown>;
    /** Stable per-client id; pairs with {@link OutboxMutation.mutationId} as `idempotencyKey`. */
    clientId: string;
    functionPath: string;
    /** `${clientId}:${mutationId}` — sent as `x-lunora-mutation-id` so a replay is server-idempotent. */
    idempotencyKey: string;
    /** Issuing identity fingerprint (`null` = signed out); drives the sink's identity guard. */
    identity: string | null;
    /** Monotonic per-client mutation id, backing the server `__client_watermark`. */
    mutationId: number;
    shardKey?: string;
}

/**
 * Pluggable durable outbox seam. When set on {@link LunoraClientOptions.outbox},
 * the client delegates offline write durability + at-least-once replay to this
 * sink instead of its built-in {@link PersistenceAdapter}-backed `OfflineQueue`.
 * `@lunora/db` supplies the blessed implementation (`createExecutorOutboxSink`,
 * backed by the TanStack `OfflineExecutor`); the interface itself is
 * dependency-free so `@lunora/client` stays TanStack-free.
 */
export interface OutboxSink {
    /**
     * Persist and schedule a write for replay. Rejects with an
     * `OFFLINE_QUEUE_OVERFLOW`-coded error when the sink's cap is exceeded, so
     * the caller can surface back-pressure to the issuing mutation.
     */
    enqueue: (mutation: OutboxMutation) => Promise<void>;
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

    /**
     * The CDC `epoch` the `serverCursor` belongs to, replayed as `sinceEpoch`
     * on reconnect so the server only resumes when the client is still on the
     * same changelog timeline. Absent when no epoch was advertised.
     */
    serverEpoch?: string;

    /** Wall-clock millis the value was written — drives LRU eviction. */
    ts: number;

    /** The full query result last seen from the server. */
    value: unknown;

    /**
     * App/schema version stamped when persisted (from `LunoraClientOptions.persistenceVersion`).
     * A cached value whose `version` doesn't match the current one is not hydrated —
     * so a result of a now-changed shape from an older deploy can't render. Absent
     * when no `persistenceVersion` is configured (no version gating).
     */
    version?: string;
}

/** A stored read-cache row: the {@link CachedQuery} plus the key it is stored under. */
export interface StoredQuery extends CachedQuery {
    key: string;
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
    load: () => Promise<StoredQuery[]>;
    /** Upsert one cached query by key (called when a subscription value advances). */
    put: (key: string, entry: CachedQuery) => Promise<void>;
    /** Remove one cached query by key. */
    remove: (key: string) => Promise<void>;
}

/**
 * Resolves the WS `?token=` credential fresh at every (re)connect — the channel
 * for short-lived tokens (e.g. the ephemeral admin sub-token the worker mints
 * at `POST /_lunora/admin/ws-token`) instead of a static secret in the URL.
 * May return the token synchronously or as a Promise; returning `undefined`
 * connects without a token. A thrown error / rejected Promise fails that
 * connect attempt, and the client retries with its normal reconnect backoff.
 */
export type WsTokenProvider = () => Promise<string | undefined> | string | undefined;

export interface LunoraClientOptions {
    /**
     * Base path the worker mounts better-auth at, used by the client's
     * `getCurrentUser()` to reach the `get-session` route. Defaults to
     * `/api/auth` (matching `@lunora/auth`'s `DEFAULT_AUTH_BASE_PATH`).
     */
    authBasePath?: string;
    bookmarkStorage?: BookmarkStorage;

    /**
     * Stable per-client id backing the custom-mutator watermark. Sent on the
     * `connect` envelope (so the server can scope this client's
     * `__client_watermark`) and stamped onto every {@link OutboxMutation} the
     * {@link LunoraClientOptions.outbox} sink persists, where it pairs with the
     * monotonic mutation id to form the idempotency key. The `@lunora/db` path
     * persists a stable id alongside the outbox and passes it here; omit for the
     * standalone client, which generates an ephemeral per-session id.
     */
    clientId?: string;

    /**
     * Default app context sent in the `connect` envelope right after each socket
     * opens, forwarded to the server's `onConnect`/`onDisconnect` lifecycle hooks
     * as `event.context`. A per-shard context registered via
     * `setConnectionContext` overrides this for that shard. Omit when no lifecycle
     * hook needs connection context.
     */
    connectionContext?: Record<string, unknown>;

    /**
     * Fail-fast timeout (ms) for opening a subscription WebSocket. If the
     * handshake doesn't complete within this window — a hung dev proxy or a cold
     * worker that never upgrades — the client force-closes the socket and routes
     * through its normal reconnect/backoff (surfacing `offline` status) instead
     * of leaving the live channel silently stuck on the browser's much longer
     * default. Does not affect HTTP queries/mutations (those never ride the WS).
     * Defaults to 10000 (10s); set to `0` (or negative) to disable.
     */
    connectTimeoutMs?: number;

    /**
     * When `true`, tabs sharing the same origin (and the same signed-in identity)
     * coordinate via BroadcastChannel so only one tab — the "leader" — opens
     * WebSocket connections to the server. Reduces simultaneous WS connections,
     * bandwidth, and cross-tab state drift. Requires `BroadcastChannel`
     * (browser-only); silently ignored otherwise. Defaults to `false`.
     *
     * **The channel is one-directional: leader → follower.** The leader
     * broadcasts the values, errors, checkpoints and connection status of the
     * subscriptions *it* holds; there is no frame with which a follower can ask
     * the leader for anything.
     *
     * `subscribe` works on a follower and is how the relay delivers: the
     * registration is what the leader's broadcast key is matched against, so a
     * follower sees a value while the leader independently holds the same
     * `(fn, args, shardKey)`.
     *
     * Nothing else is served, because the leader broadcasts nothing for it and a
     * follower cannot ask. `subscribeShape` and `acquireConnectionContext` are
     * inert on a follower — framework code (`@lunora/db`'s shape sync, every
     * `usePresence` adapter) calls them from an effect the app cannot opt out
     * of, so throwing would unwind the tab rather than degrade one feature.
     * `whisper`, `whisperSubscribe`, `setConnectionContext` and `stream` are
     * only ever called by app code, which can handle a failure, so those throw
     * `NOT_IMPLEMENTED` rather than returning a handle that never fires. (The
     * brief window every tab spends claiming leadership at startup is not a
     * follower state: a lone tab self-promotes and its registered subscriptions
     * are sent then.) HTTP surfaces — `query`, `mutation`, `action`, the offline
     * queue's replay — are unaffected on every tab.
     *
     * So: enable this when your tabs run the SAME app views over plain
     * `subscribe`, and leave it off if tabs can sit on different routes or you
     * use shapes, whispers, streams, or connection context.
     */
    crossTabSync?: boolean;
    fetch?: typeof fetch;

    /**
     * Interval (ms) between keepalive pings sent on each open subscription
     * socket. The server answers them via the Durable Object's hibernation
     * auto-response WITHOUT waking the DO, so an idle socket stays alive across
     * hibernation without a billable wakeup. Defaults to 30000 (30s); set to
     * `0` (or a negative value) to disable the heartbeat entirely.
     */
    heartbeatIntervalMs?: number;

    /**
     * When `true` and a `queryCache` is active, React's `useQuery` holds its
     * TanStack query disabled until the durable cache has finished loading
     * (`whenReady()`), so its first enabled render can seed the cached value
     * instead of issuing an HTTP read that the cache would immediately
     * overwrite. Defaults to `false`.
     *
     * It is ONLY React's `useQuery` that defers — the Vue, Svelte, Solid and
     * Angular hooks subscribe at mount regardless of this flag, and so does
     * React's own subscription registry. They do not need the gate: a
     * subscription opened before the load completes is seeded by the load
     * itself, so a cached value reaches the first subscriber either way.
     *
     * Requires `queryCache` to be set (not `false`); silently ignored otherwise.
     */
    hydrateOnStart?: boolean;

    offlineQueue?: OfflineQueueOptions;

    /**
     * Durable outbox seam for offline writes. When supplied (the `@lunora/db`
     * path wires `createExecutorOutboxSink`), offline mutations are delegated to
     * the sink and the built-in {@link PersistenceAdapter}-backed `OfflineQueue`
     * is bypassed, so a db app has exactly one durable write path. Omit for the
     * standalone client, which keeps using {@link LunoraClientOptions.persistence}.
     */
    outbox?: OutboxSink;

    /**
     * Durable store for the offline mutation queue. Tri-state — an explicit
     * {@link PersistenceAdapter} is used as-is; `false` opts out (the queue stays
     * in memory, lost on reload); omitted (the default) auto-probes a durable
     * IndexedDB store when the `indexedDB` global is present (browsers), otherwise
     * in-memory, so SSR/Node/React-Native keep the in-memory behaviour and only
     * environments that can persist do. Pass `createAsyncStoragePersistence()` on
     * React Native.
     */
    persistence?: false | PersistenceAdapter;

    /**
     * App/schema version stamped onto every persisted queued write and cached
     * read. Bump it on a breaking change to a function signature or query shape:
     * on the next boot, persisted writes / cached reads stamped with a different
     * version are dropped (and purged) rather than replayed / hydrated against the
     * new schema. Omit to disable version gating (records are never invalidated by
     * version).
     *
     * **Adoption is itself an invalidation event:** records written before you set
     * `persistenceVersion` carry no version, so the first boot after enabling it
     * purges all currently-queued offline writes (and cached reads) as stale. Adopt
     * it on a build where that clean slate is acceptable — typically the same
     * breaking deploy you're protecting against — not purely speculatively.
     */
    persistenceVersion?: string;

    /**
     * Durable store for the read cache (Pillar 2). When active, query results
     * are persisted as their subscriptions advance and hydrated on construction
     * so a reload renders cached data before the socket reconnects, then resumes
     * the live subscription from the persisted cursor. Tri-state — an explicit
     * {@link QueryCacheAdapter} is used as-is; `false` opts out (reads stay in
     * memory only); omitted (the default) auto-probes IndexedDB exactly like
     * {@link LunoraClientOptions.persistence}.
     */
    queryCache?: QueryCacheAdapter | false;
    reconnect?: ReconnectOptions;
    url: string;
    WebSocket?: typeof WebSocket;

    /**
     * Credential appended to the WebSocket URL as `?token=…`. The server matches
     * it against `LUNORA_WS_BEARER` (to clear the upgrade gate) and/or
     * `LUNORA_ADMIN_TOKEN` (to authorize `__lunora_admin__:*` subscriptions —
     * what the studio supplies). Browsers can't set headers on the `WebSocket`
     * constructor, so the query parameter is the only channel; it ends up in
     * server logs and history, so prefer a short-lived rotating token in
     * production over a static secret.
     *
     * Pass a {@link WsTokenProvider} function to resolve the token fresh at
     * every (re)connect — the channel for short-lived credentials such as the
     * ephemeral admin sub-token minted by `POST /_lunora/admin/ws-token`: the
     * provider re-mints on each reconnect, including the one following a `4001`
     * token-expired drop, so a static master token never has to ride the URL.
     */
    wsToken?: string | WsTokenProvider;
    wsUrl?: string;
}

/** Wire envelope sent on `POST /_lunora/rpc`. */
export interface RpcEnvelope {
    args?: Record<string, unknown>;

    /**
     * Stable per-client identifier (custom-mutator push path). Pairs with
     * {@link RpcEnvelope.mutationId} to form `idempotencyKey` and scope the
     * server `__client_watermark`. Absent on plain `client.mutation` calls.
     */
    clientId?: string;
    functionPath: string;

    /**
     * Idempotency key (`${clientId}:${mutationId}`) for the custom-mutator push
     * path, mirrored into the `x-lunora-mutation-id` header. Absent on plain
     * `client.mutation` calls.
     */
    idempotencyKey?: string;

    /**
     * Monotonic per-client mutation id (custom-mutator push path), backing the
     * server-side per-client watermark: `id <= watermark` is a replay (skipped),
     * `id == watermark + 1` runs authoritatively, `id > watermark + 1` halts the
     * batch so the client resends from `watermark + 1`. Absent on plain
     * `client.mutation` calls.
     */
    mutationId?: number;
    shardKey?: string;
}

/**
 * Wire response from the shard's `/rpc` endpoint (forwarded by the runtime). A
 * watermarked custom-mutator push additionally carries `lastMutationId` — the
 * highest per-client sequence the DO has applied — which the client uses to keep
 * its `clientSeq` generator monotonic across reloads (see `LunoraClient.callMutator`).
 * A plain mutation on a CDC shard carries `commitCursor` — the cursor the write
 * committed at — which gates the drop of a per-call optimistic layer.
 */
export type RpcResponseBody =
    { error: { code: string; data?: unknown; message: string } } | { commitCursor?: number; lastMutationId?: number; result: unknown };

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
    query: { args?: Record<string, unknown>; functionPath?: string; sinceEpoch?: string; sinceSeq?: number; table?: string };
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
    /**
     * Wire behaviours this client can handle that an older one cannot, so the
     * server can use them without breaking clients that can't. Currently just
     * `"pageDelta"`; see `shared/page-result.ts` for what it promises and why it
     * must be announced rather than assumed. Omitting it is always safe.
     */
    caps?: ReadonlyArray<string>;

    /**
     * Stable per-client id (persisted alongside the outbox). Lets the server
     * scope this connection's `__client_watermark` so custom-mutator pokes can
     * echo the right per-client `lastMutationId`. Omitted by clients that don't
     * use custom mutators.
     */
    clientId?: string;
    context?: Record<string, unknown>;
    id: string;
    type: "connect";
}

/**
 * Subscribe to a declarative **shape** — server-side partial replication scoped
 * by `shardBy` + the shape's predicate + RLS. The client sends the shape *name*
 * + validated `args`; the server resolves the trusted `where` (identity/RLS
 * `baseWhere` the client can't forge) and streams the matching rowset, then live
 * {@link ServerPokePartMessage} diffs. `id` namespaces the subscription and is
 * echoed as `shapeId` on every poke part.
 */
export interface ClientShapeSubscribeMessage {
    id: string;
    shape: { args?: Record<string, unknown>; name: string };

    /**
     * Resume from this checkpoint (the `__cdc_log` cursor the client last
     * applied for this shape). When absent or below the server's retained floor
     * (`minCdcSeq`), the server re-seeds with a full insert-poke instead of a
     * delta.
     */
    sinceCheckpoint?: number;

    /**
     * The CDC epoch {@link ClientShapeSubscribeMessage.sinceCheckpoint} belongs
     * to. A mismatch (forked changelog timeline) forces a full re-seed even when
     * the cursor is numerically in range.
     */
    sinceEpoch?: string;
    type: "shape_subscribe";
}

/** Cancel a shape subscription started with the same `id`. */
export interface ClientShapeUnsubscribeMessage {
    id: string;
    type: "shape_unsubscribe";
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
    /**
     * Run generation the {@link ClientStreamMessage.sinceChunk} watermark
     * belongs to: the `generation` stamp carried by the chunk frames this
     * client already received, echoed back on a resume. The server refuses to
     * splice a different run's tail onto the held prefix — a mismatch fails
     * with `STREAM_INTERRUPTED` instead. Omitted on a first attach.
     */
    generation?: number;
    id: string;
    query: { args?: Record<string, unknown>; functionPath: string; shardKey?: string };

    /**
     * Resume watermark: the highest chunk `seq` this client already received.
     * Only meaningful for a stream the server declared `durable` — the run
     * replays everything after it and then continues live, which is what turns
     * a reconnect into a resume instead of a lost generation. Omitted on a
     * first attach.
     *
     * Named `sinceChunk`, not `sinceSeq`, because a subscribe envelope already
     * carries a `query.sinceSeq` meaning the CDC cursor.
     */
    sinceChunk?: number;
    type: "stream";
}

/**
 * Join or leave a whisper `topic` — an app-chosen ephemeral channel scoped to a
 * shard. While joined, the client receives every {@link ServerWhisperMessage}
 * other members broadcast to the topic.
 */
export interface ClientWhisperSubscribeMessage {
    topic: string;
    type: "whisper_subscribe" | "whisper_unsubscribe";
}

/**
 * Broadcast ephemeral `data` to the topic's other members on the shard. The
 * payload is relayed verbatim with no server-side persistence (no SQLite/CDC
 * write) — for typing indicators, live cursors, presence pings. The sender does
 * not receive its own whisper.
 */
export interface ClientWhisperMessage {
    data?: unknown;
    topic: string;
    type: "whisper";
}

export type ClientMessage =
    | ClientAckMessage
    | ClientConnectMessage
    | ClientShapeSubscribeMessage
    | ClientShapeUnsubscribeMessage
    | ClientStreamMessage
    | ClientSubscribeMessage
    | ClientUnsubscribeMessage
    | ClientWhisperMessage
    | ClientWhisperSubscribeMessage;

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
    /** The CDC epoch this frame's cursor belongs to (see {@link CachedQuery.serverEpoch}). */
    epoch?: string;
    id: string;

    /**
     * The highest custom-mutator `mutationId` from this client the server has
     * now applied (the per-client `__client_watermark`). Echoed so the client's
     * outbox can drop confirmed pending mutations and let TanStack DB collapse
     * the matching optimistic overlay. Absent on shards without custom mutators.
     */
    lastMutationId?: number;
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
    /** The CDC epoch this resume's cursor belongs to (see {@link CachedQuery.serverEpoch}). */
    epoch?: string;
    id: string;
    /** Per-client custom-mutator watermark (see {@link ServerDataMessage.lastMutationId}). */
    lastMutationId?: number;
    type: "resume";
}

/**
 * Settled acknowledgement for a **list** subscription: a write touched one of
 * the subscription's read tables but produced a byte-identical result, so the
 * server suppressed the data frame. Sent ONLY to a `@lunora/db` custom-mutator
 * client (one that announced a `clientId`, hence has a server-side
 * `__client_watermark`) so its optimistic list overlay drops even when no data
 * frame arrives. Plain `useQuery` subscribers never receive it, and an older
 * client safely ignores the unknown frame.
 */
export interface ServerSettledMessage {
    cursor?: number;
    /** The CDC epoch this settled frame's cursor belongs to (see {@link CachedQuery.serverEpoch}). */
    epoch?: string;
    id: string;

    /**
     * The highest custom-mutator `mutationId` from this client the server has
     * now applied (the per-client `__client_watermark`). Forwarded to a
     * collection's `onCheckpoint` so it can drop the overlay for the confirmed
     * write whose result didn't change this list.
     */
    lastMutationId?: number;
    type: "settled";
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

    /**
     * Generation stamp of the **durable** run this chunk belongs to. The client
     * stores it beside {@link ServerChunkMessage.seq} and echoes it as
     * {@link ClientStreamMessage.generation} on a resume, so the server can
     * tell a genuine resume from an attempt to splice onto a different run
     * under the same key. Absent on an ephemeral stream.
     */
    generation?: number;
    id: string;

    /**
     * Monotonic position of this chunk within a **durable** run, starting at 1.
     * The client stores the last one it saw and replays it as
     * {@link ClientStreamMessage.sinceChunk} when the socket comes back. Absent
     * on an ephemeral stream, which has nothing to resume from.
     */
    seq?: number;
    type: "chunk";
}

/**
 * An ephemeral whisper relayed from another member of `topic` on the same shard
 * (AnyCable-style whispering). `data` is the sender's payload verbatim; `from`
 * is the sender's verified user id when known (absent for an anonymous sender).
 * Never persisted server-side.
 */
export interface ServerWhisperMessage {
    data: unknown;
    from?: string;
    topic: string;
    type: "whisper";
}

/**
 * One row-level change in a shape's replication stream — the wire form of the
 * DO's `__cdc_log` `CdcChange`. `insert`/`update` carry the post-image in
 * `value` (projected to the shape's `columns`); `delete` omits it, identifying
 * the removed row by `key` alone. The client applies these to its local
 * collection; an unknown `key` on a `delete` is a safe no-op (a row the client
 * never had in this shape).
 */
export interface RowOp {
    /** Row primary key (`_id`). */
    key: string;
    op: "delete" | "insert" | "update";
    /** Logical table the row belongs to. */
    table: string;
    /** Post-image document for insert/update; absent on delete. */
    value?: Record<string, unknown>;
}

/**
 * Opens a **poke** — an atomically-applied batch of shape diffs (Zero's poke
 * protocol). A `pokeStart` is followed by zero or more {@link ServerPokePartMessage}
 * frames and closed by exactly one {@link ServerPokeEndMessage}; the client
 * buffers every part and applies them in a single transaction at `pokeEnd`, so a
 * socket that drops mid-poke simply re-seeds on reconnect (no torn view).
 */
export interface ServerPokeStartMessage {
    /**
     * Poke-level fallback base, stamped by single-part senders. Per-shape
     * {@link ServerPokePartMessage.baseCheckpoint} takes precedence; this is what
     * a part without its own base falls back to.
     */
    baseCheckpoint?: number;
    /** CDC epoch this poke belongs to; a mismatch forces the client to re-seed rather than apply. */
    epoch?: string;
    /** Correlates this poke's `pokeStart`/`pokePart`/`pokeEnd` frames. */
    pokeId: string;
    type: "pokeStart";
}

/** One shape's slice of an in-flight poke: the row-ops to apply for `shapeId`. */
export interface ServerPokePartMessage {
    /**
     * The checkpoint this shape's view must be at for `rowsPatch` to splice on
     * cleanly. Per shape, because every shape on a socket has its own
     * delivered-through cursor. Absent when the server cannot name a base — the
     * gap check is then disarmed for this part, never guessed at.
     */
    baseCheckpoint?: number;
    /** Per-client custom-mutator watermark carried with this slice (see {@link ServerSettledMessage.lastMutationId}). */
    lastMutationId?: number;
    pokeId: string;

    /**
     * `true` when `rowsPatch` is the shape's COMPLETE membership, not a diff (a
     * full seed or re-seed). The client MUST drop its current view for this shape
     * before applying: a seed is inserts-only, so merging it leaves any row that
     * left the shape while the client was disconnected on screen forever.
     *
     * Never inferred from an absent {@link ServerPokePartMessage.baseCheckpoint} —
     * most live poke paths legitimately carry no base.
     */
    reset?: boolean;
    /** Ordered row-level changes for this shape, applied in sequence at `pokeEnd`. */
    rowsPatch: RowOp[];
    /** The {@link ClientShapeSubscribeMessage.id} these row-ops belong to. */
    shapeId: string;
    type: "pokePart";
}

/**
 * Closes a poke: the client commits the buffered parts atomically and advances
 * its checkpoint to {@link ServerPokeEndMessage.checkpoint} (the `__cdc_log`
 * cursor high-watermark the view now reflects), replayed as `sinceCheckpoint` on
 * the next reconnect.
 */
export interface ServerPokeEndMessage {
    /** The `__cdc_log` cursor the view is at after applying this poke. */
    checkpoint?: number;
    /** CDC epoch the {@link ServerPokeEndMessage.checkpoint} belongs to. */
    epoch?: string;
    pokeId: string;
    type: "pokeEnd";
}

export type ServerMessage =
    | ServerAckMessage
    | ServerChunkMessage
    | ServerCompleteMessage
    | ServerDataMessage
    | ServerErrorMessage
    | ServerPokeEndMessage
    | ServerPokePartMessage
    | ServerPokeStartMessage
    | ServerResumeMessage
    | ServerSettledMessage
    | ServerWhisperMessage;

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
 * Per-job retry policy carried on a {@link ScheduleRecord}. Mirrors
 * `@lunora/scheduler`'s `RetryPolicy`; absent means the scheduler's defaults.
 */
export interface ScheduleRetryPolicy {
    /** Backoff growth across attempts. Default `"exponential"`. */
    backoff?: "exponential" | "linear";
    /** Base delay in milliseconds for the first retry. Default `30_000`. */
    baseMs?: number;
    /** Maximum number of dispatch attempts before dead-lettering. Default `5`. */
    maxAttempts?: number;
    /** Optional ceiling clamping the computed backoff delay. */
    maxMs?: number;
}

/**
 * One pending scheduled function, as returned by the worker's
 * `GET /_lunora/admin/scheduled` endpoint. The route is a byte-for-byte proxy of
 * the SchedulerDO's own `/list`, so this mirrors `@lunora/scheduler`'s
 * `ScheduleRecord` field-for-field — structurally, so the client carries no
 * dependency on it. `packages/client/__tests__/structural-mirrors.test.ts` fails
 * when the two drift.
 */
export interface ScheduleRecord {
    args: Record<string, unknown>;

    /**
     * Dispatch attempts already made. Absent (treated as 0) until the first
     * failure; on a dead-letter record it is the exhausted count (> the retry
     * budget). Surfaced so the studio can show how hard a job tried before it
     * was parked.
     */
    attempts?: number;
    enqueuedAt: number;

    /**
     * The `ns:fn` path dispatched on fire. Absent when the job targets a durable
     * workflow/agent instead — exactly one of `functionPath` /
     * {@link ScheduleRecord.workflow} is set, so a view rendering a job's target
     * must fall back to `workflow` rather than assuming a path.
     */
    functionPath?: string;
    id: string;
    /** Scheduler/workpool instance the job was enqueued through. Absent for the default instance. */
    instanceName?: string;
    /** Logical workpool the job is routed to (concurrency-gated), when any. */
    pool?: string;
    /** Per-job retry policy; absent means the scheduler's built-in defaults. */
    retry?: ScheduleRetryPolicy;
    scheduledFor: number;
    shardKey?: string;

    /**
     * The `WORKFLOW_*`/`AGENT_*` binding a fresh durable instance is started from
     * on fire (the {@link ScheduleRecord.args} become its `params`). Set instead
     * of {@link ScheduleRecord.functionPath}.
     */
    workflow?: string;
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
 * `GET /_lunora/admin/functions` endpoint: its `<file>:<function>` path, which
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
 * the `<file>:<function>` path it invokes, its human `name`, and any bound
 * `args` / `shardKey`. Static for the deployment (Cloudflare exposes no runtime
 * cron introspection), so the studio renders these read-only.
 */
// The admin wire-shape types `CronJobInfo` (cron-triggers tab), `VectorIndexSummary`
// + `VectorQueryMatch` (vector browser), and the KV browser types are owned by the
// runtime contract (`@lunora/runtime`, which defines the `/_lunora/admin/*` endpoints)
// and re-exported here for SDK consumers — a single source of truth, no hand-kept
// copies to drift. Type-only re-export, so no worker code reaches the browser SDK.
export type { CronJobInfo, KvKeyEntry, KvKeyListResult, KvNamespaceSummary, KvValueResult, VectorIndexSummary, VectorQueryMatch } from "@lunora/runtime";
// The durable log-archive wire types, owned by `@lunora/runtime` (the reader) and
// re-exported here so the studio's `queryLogArchive` shares one source of truth.
export type { PipelineLogColumnMap, PipelineLogCursor, PipelineLogField, PipelineLogPage, PipelineLogQuery, PipelineLogRow } from "@lunora/runtime";

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

// --- Cloudflare Workflows observability (the `/_lunora/admin/workflows*` proxy) ---
// Wire shapes for the studio's workflow views. Mirror `@lunora/workflow`'s REST
// shapes (kept local like `ScheduleRecord`, so the browser SDK pulls in no
// worker/REST code); the proxy already normalizes Cloudflare's snake_case.

/** A workflow instance's lifecycle status. Mirrors Cloudflare's `InstanceStatus`. */
export type WorkflowInstanceStatus = "complete" | "errored" | "paused" | "queued" | "running" | "terminated" | "unknown" | "waiting" | "waitingForPause";

/** The lifecycle mutations the status endpoint accepts. */
export type WorkflowInstanceAction = "pause" | "resume" | "terminate";

/** One row of the workflow-instances list. */
export interface WorkflowInstanceSummary {
    createdOn?: string;
    endedOn?: string;
    id: string;
    startedOn?: string;
    status: WorkflowInstanceStatus;
}

/** One durable step of an instance's execution timeline. */
export interface WorkflowStepDetail {
    /** 1-based attempt count (`> 1` means the step retried). */
    attempts?: number;
    end?: string;
    error?: unknown;
    name: string;
    output?: unknown;
    start?: string;
    success?: boolean;
    /** `step` / `sleep` / `waitForEvent` / … (Cloudflare's step `type`). */
    type?: string;
}

/** A workflow instance's full detail: summary plus params/output/error and the step timeline. */
export interface WorkflowInstanceDetail extends WorkflowInstanceSummary {
    error?: unknown;
    output?: unknown;
    params?: unknown;
    steps: WorkflowStepDetail[];
}

/** A page of workflow instances. */
export interface WorkflowInstancePage {
    /**
     * Whether workflow inspection is configured on the worker (a Cloudflare
     * account id + API token). `false` when the admin proxy reports it can't
     * inspect instances; omitted (treated as configured) otherwise. Lets a
     * caller render a "set credentials" state without a failed request.
     */
    configured?: boolean;
    instances: WorkflowInstanceSummary[];
    page: number;
    perPage: number;
    totalCount?: number;
}

// The auth wire-shape types (`AuthUser`/`AuthSession`/`AuthPage`/`AuthImpersonation`/
// `AuthCapabilities`) are owned by the runtime contract (`@lunora/runtime`, the
// package that defines the `/_lunora/admin/auth/*` endpoints) and re-exported here
// for SDK consumers — a single source of truth, no hand-kept copies. This is a
// type-only re-export, so no runtime/worker code is pulled into the browser SDK.
export type { AuthCapabilities, AuthConfigInfo, AuthImpersonation, AuthPage, AuthSession, AuthUser, AuthUserFieldSpec } from "@lunora/runtime";
