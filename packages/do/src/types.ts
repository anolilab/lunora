export interface SubscriptionQuery {
    args?: Record<string, unknown>;

    /**
     * `&lt;file>:&lt;function>` identifier of the query to re-run server-side when
     * a write touches a table it reads. Present on subscriptions that opt into
     * server re-execution; absent on legacy delta-only subscriptions, which
     * are matched by {@link table} alone.
     */
    functionPath?: string;

    /**
     * Table name the legacy raw-delta fan-out path matches against. Kept for
     * `broadcastDelta`; the server re-execution path keys off
     * {@link functionPath} instead.
     */
    table?: string;
}

export interface SubscriptionEnvelope {
    id: string;
    query?: SubscriptionQuery;

    /**
     * `subscribe`/`unsubscribe`/`ack` drive live queries; `stream` opens a
     * streaming-query iterator that yields {@link ServerChunkMessage} frames
     * until the server emits `complete` (or the client cancels with
     * `unsubscribe` on the same id).
     */
    type: "ack" | "stream" | "subscribe" | "unsubscribe";
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
     * `true` when the upgrade presented a token matching `CIRRUS_ADMIN_TOKEN`,
     * gating the reserved `__cirrus_admin__:*` introspection subscriptions to
     * the same credential as the HTTP admin RPCs. Absent/`false` on ordinary
     * user-subscription sockets, which may never read admin data over the wire.
     */
    admin?: boolean;
    subs: Record<string, SubscriptionQuery>;
}
