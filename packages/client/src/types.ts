/**
 * Opaque reference to a registered function emitted by `@cirrus/codegen`.
 *
 * At runtime it carries the `<file>:<function>` identifier in `__cirrusRef`.
 * Generated declarations decorate this with phantom type parameters so the
 * client can infer args / return values per call site.
 */
export interface FunctionReference<_Kind extends "query" | "mutation" | "action" = "query" | "mutation" | "action", _Args = unknown, _Return = unknown> {
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
 * queue in memory; supplying an adapter (e.g. {@link createIndexedDbPersistence})
 * makes queued writes survive a page reload. Implementations must preserve FIFO
 * (enqueue) order in {@link PersistenceAdapter.load}.
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
    bookmarkStorage?: BookmarkStorage;
    fetch?: typeof fetch;
    offlineQueue?: OfflineQueueOptions;
    /** Durable store for the offline mutation queue; omit to keep it in memory. */
    persistence?: PersistenceAdapter;
    reconnect?: ReconnectOptions;
    url: string;
    WebSocket?: typeof WebSocket;
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

export type ClientMessage = ClientSubscribeMessage | ClientUnsubscribeMessage | ClientAckMessage;

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

export type ServerMessage = ServerDataMessage | ServerErrorMessage | ServerAckMessage | ServerCompleteMessage;

export interface User {
    readonly email?: string;
    readonly id: string;
    readonly [key: string]: unknown;
}
