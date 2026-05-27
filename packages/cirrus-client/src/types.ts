/**
 * Opaque reference to a registered function emitted by `@cirrus/codegen`.
 *
 * At runtime it carries the `<file>:<function>` identifier in `__cirrusRef`.
 * Generated declarations decorate this with phantom type parameters so the
 * client can infer args / return values per call site.
 */
export interface FunctionReference<
    _Kind extends "query" | "mutation" | "action" = "query" | "mutation" | "action",
    _Args = unknown,
    _Return = unknown,
> {
    readonly __cirrusRef: string;
}

/** Extract the args type from a {@link FunctionReference}. */
export type ArgsOf<F> = F extends FunctionReference<infer _K, infer A, infer _R> ? A : never;

/** Extract the return type from a {@link FunctionReference}. */
export type ReturnOf<F> = F extends FunctionReference<infer _K, infer _A, infer R> ? R : never;

export type Unsubscribe = () => void;

/**
 * Pluggable storage for the `x-d1-bookmark` value used to provide
 * read-your-writes between a mutation and subsequent queries.
 */
export interface BookmarkStorage {
    get(): string | null;
    set(value: string | null): void;
}

export interface ReconnectOptions {
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
}

export interface OfflineQueueOptions {
    maxItems?: number;
}

export interface CirrusClientOptions {
    url: string;
    wsUrl?: string;
    fetch?: typeof fetch;
    WebSocket?: typeof WebSocket;
    reconnect?: ReconnectOptions;
    offlineQueue?: OfflineQueueOptions;
    bookmarkStorage?: BookmarkStorage;
}

/** Wire envelope sent on `POST /_cirrus/rpc`. */
export interface RpcEnvelope {
    functionPath: string;
    args?: Record<string, unknown>;
    shardKey?: string;
}

/** Wire response from the shard's `/rpc` endpoint (forwarded by the runtime). */
export type RpcResponseBody = { result: unknown } | { error: { code: string; message: string } };

/** Subscription protocol — client → server. */
export interface ClientSubscribeMessage {
    type: "subscribe";
    id: string;
    query: { table: string; args?: Record<string, unknown> };
}

export interface ClientUnsubscribeMessage {
    type: "unsubscribe";
    id: string;
}

export interface ClientAckMessage {
    type: "ack";
    id: string;
}

export type ClientMessage = ClientSubscribeMessage | ClientUnsubscribeMessage | ClientAckMessage;

/** Subscription protocol — server → client. */
export interface ServerDataMessage {
    type: "data" | "delta";
    id: string;
    data?: unknown;
    delta?: unknown;
}

export interface ServerErrorMessage {
    type: "error";
    id?: string;
    error?: unknown;
    message?: string;
}

export interface ServerAckMessage {
    type: "ack";
    id: string;
}

export interface ServerCompleteMessage {
    type: "complete";
    id: string;
}

export type ServerMessage = ServerDataMessage | ServerErrorMessage | ServerAckMessage | ServerCompleteMessage;

export interface User {
    readonly id: string;
    readonly email?: string;
    readonly [key: string]: unknown;
}
