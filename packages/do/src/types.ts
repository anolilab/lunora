export interface SubscriptionQuery {
    args?: Record<string, unknown>;

    /**
     * `&lt;file>:&lt;function>` identifier of the query to re-run server-side when
     * a write touches a table it reads. Present on subscriptions that opt into
     * server re-execution; absent on legacy delta-only subscriptions, which
     * are matched by `table` alone.
     */
    functionPath?: string;

    /**
     * Table name the legacy raw-delta fan-out path matches against. Kept for
     * `broadcastDelta`; the server re-execution path keys off
     * `functionPath` instead.
     */
    table?: string;
}

export interface SubscriptionEnvelope {
    /**
     * App-supplied connection context carried by the `connect` envelope (e.g.
     * `{ roomId, sessionId }`). Merged into the socket attachment and forwarded
     * to every lifecycle hook as `event.context`. Ignored on other envelope types.
     */
    context?: Record<string, unknown>;
    id: string;
    query?: SubscriptionQuery;

    /**
     * `subscribe`/`unsubscribe`/`ack` drive live queries; `stream` opens a
     * streaming-query iterator that yields `ServerChunkMessage` frames
     * until the server emits `complete` (or the client cancels with
     * `unsubscribe` on the same id). `connect` is the one-shot control frame the
     * client sends right after the socket opens to register its connection
     * `context` and fire the `onConnect` lifecycle hooks.
     */
    type: "ack" | "connect" | "stream" | "subscribe" | "unsubscribe";
}

/**
 * The argument a connection-lifecycle hook receives. Structurally matches
 * `@lunora/server`'s `LifecycleEvent`; defined here so `@lunora/do` stays free of
 * a dependency on the API package. The DO forwards it verbatim as the hook's
 * `args`, and the generated handler casts it back to the typed shape.
 */
export interface LifecycleEvent {
    /** Stable per-socket id minted at upgrade, replayed verbatim on disconnect. */
    connectionId: string;
    /** App-supplied connection context from the client `connect` envelope. */
    context?: Record<string, unknown>;
    /** This DO's shard name. */
    shardKey: string;
    /** Verified user id resolved at upgrade, or `null` for an anonymous socket. */
    userId: string | null;
}

/**
 * Per-socket lifecycle dispatch payload assembled from the attachment at
 * connect/close: the {@link LifecycleEvent} the hooks receive plus the verified
 * identity to replay so each hook runs under the connecting user.
 */
export interface LifecycleDispatchInfo {
    event: LifecycleEvent;
    identity: Record<string, unknown> | undefined;
    userId: string | undefined;
}

export interface MutationDelta {
    key: string;
    op: "insert" | "update" | "delete";
    row?: Record<string, unknown>;
    table: string;
}

export interface RpcRequest {
    args?: Record<string, unknown>;
    functionPath: string;
}

/**
 * Per-WebSocket metadata that survives hibernation via
 * `ws.serializeAttachment` / `ws.deserializeAttachment`.
 *
 * Wire format reminder — every JSON envelope on the socket carries `type`
 * and `id`, the latter echoed back by the runtime so the client can match
 * acks/deltas to outstanding subscriptions. The shapes the runtime emits:
 *
 * ```jsonc
 * // client -> server (subscribe)
 * { "type": "subscribe",   "id": "sub-1", "query": { "table": "messages" } }
 * // server -> client (ack)
 * { "type": "ack",         "id": "sub-1" }
 *
 * // client -> server (unsubscribe)
 * { "type": "unsubscribe", "id": "sub-1" }
 * // server -> client (ack)
 * { "type": "ack",         "id": "sub-1" }
 *
 * // server -> client (delta) — fan-out from broadcastDelta
 * { "type": "delta", "id": "sub-1",
 *   "delta": { "table": "messages", "op": "insert", "key": "msg-42",
 *              "row": { "_id": "msg-42", "text": "hi" } } }
 * ```
 *
 * The attachment itself only persists the live `subs` map; ack/delta
 * messages are derived on-demand from that map plus the runtime payload.
 */
export interface SocketAttachment {
    /**
     * `true` when the upgrade presented a token matching `LUNORA_ADMIN_TOKEN`,
     * gating the reserved `__lunora_admin__:*` introspection subscriptions to
     * the same credential as the HTTP admin RPCs. Absent/`false` on ordinary
     * user-subscription sockets, which may never read admin data over the wire.
     */
    admin?: boolean;

    /**
     * Stable per-socket id minted at upgrade. Its presence marks a socket that
     * has been through the lifecycle-aware upgrade path, so `webSocketClose`
     * only dispatches `onDisconnect` hooks for a socket that recorded one.
     */
    connectionId?: string;

    /**
     * App-supplied connection context from the client `connect` envelope (e.g.
     * `{ roomId, sessionId }`). Stashed here so it survives hibernation and can
     * be replayed to the `onDisconnect` hooks at close time.
     */
    context?: Record<string, unknown>;

    /**
     * Verified caller identity claims resolved at upgrade (from the
     * `x-lunora-identity` header the runtime forwards). Replayed to lifecycle
     * hooks so they run under the connecting user.
     */
    identity?: Record<string, unknown>;
    subs: Record<string, SubscriptionQuery>;

    /**
     * Verified user id resolved at upgrade (from `x-lunora-userid`), or absent
     * for an anonymous socket. Replayed to lifecycle hooks as `event.userId`.
     */
    userId?: string;
}
