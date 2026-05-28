export interface SubscriptionQuery {
    args?: Record<string, unknown>;
    /**
     * `<namespace>:<fn>` reference to the query the server re-executes on
     * writes, pushing the full result via a `{ type: "data" }` envelope.
     */
    functionPath?: string;
    /** Legacy table name used by {@link MutationDelta} broadcast matching. */
    table?: string;
}

export interface SubscriptionEnvelope {
    id: string;
    query?: SubscriptionQuery;
    type: "subscribe" | "unsubscribe" | "ack";
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
    subs: Record<string, SubscriptionQuery>;
}
