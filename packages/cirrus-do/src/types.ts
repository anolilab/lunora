export interface SubscriptionQuery {
    table: string;
    args?: Record<string, unknown>;
}

export interface SubscriptionEnvelope {
    type: "subscribe" | "unsubscribe" | "ack";
    id: string;
    query?: SubscriptionQuery;
}

export interface MutationDelta {
    table: string;
    op: "insert" | "update" | "delete";
    key: string;
    row?: Record<string, unknown>;
}

export interface RpcRequest {
    functionPath: string;
    args?: Record<string, unknown>;
}

/**
 * Per-WebSocket metadata that survives hibernation via
 * `state.serializeAttachment` / `state.deserializeAttachment`.
 */
export interface SocketAttachment {
    subs: Record<string, SubscriptionQuery>;
}
