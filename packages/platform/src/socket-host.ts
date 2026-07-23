/**
 * `SocketHost` — the provider-neutral contract for hibernated WebSocket
 * subscriptions inside a shard. On Cloudflare this is backed by the Durable
 * Object WebSocket hibernation API (`state.acceptWebSocket`,
 * `ws.serializeAttachment`, `state.getWebSockets`).
 *
 * The engine relies on three guarantees:
 * 1. **Hibernation** — a socket can be evicted from memory and rehydrated
 * later without losing its subscription state.
 * 2. **Attachment round-trip** — arbitrary JSON state serialized with the
 * socket must survive recycling and be readable on wake.
 * 3. **Tagged fan-out** — the host can enumerate live sockets (optionally by
 * tag) to broadcast query invalidations and shape updates.
 *
 * A non-Cloudflare host may keep sockets in memory or in a process-local
 * registry; the contract only requires that attachments are durable and that
 * `getSockets` returns the currently-live set.
 */

/** Opaque socket handle the host returns from `accept`. */
export interface SocketHandle {
    /** Close the socket with an optional code and reason. */
    close: (code?: number, reason?: string) => void;
    /** Read the attachment previously stored with `serializeAttachment`. */
    deserializeAttachment: () => unknown;
    /** Unique per-socket identifier, stable across hibernation. */
    readonly id: string;
    /** Send a text or binary frame. */
    send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void;
    /** Persist attachment state for this socket. */
    serializeAttachment: (value: unknown) => void;
}

/**
 * The socket host contract. One instance per shard.
 */
export interface SocketHost {
    /**
     * Accept a new WebSocket connection into the shard. `attachment` is
     * serialized immediately and must survive host recycling. Returns a
     * handle the engine can send/close through.
     */
    accept: (socket: unknown, attachment?: unknown) => SocketHandle;

    /**
     * Enumerate currently-live sockets. When `tag` is supplied, only sockets
     * previously tagged with that value are returned. Tags are a Cloudflare
     * concept; hosts without native tagging may filter in userland or ignore
     * the parameter and return all sockets.
     */
    getSockets: (tag?: string) => SocketHandle[];

    /**
     * Remove a socket's tag. Optional; a no-op is acceptable on hosts without
     * native tag support.
     */
    removeTag?: (socket: SocketHandle, tag?: string) => void;

    /**
     * Tag a socket for later fan-out filtering. Optional on hosts that don't
     * support native tags; a no-op is acceptable when the engine doesn't use
     * tag-based routing.
     */
    setTag?: (socket: SocketHandle, tag: string) => void;
}
