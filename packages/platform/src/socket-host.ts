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
 * registry; the contract requires that attachments are durable, that
 * `getSockets()` returns the currently-live set, and that `getSockets(tag)`
 * returns *only* the sockets carrying that tag.
 *
 * Tagging comes in two tiers, because hosts differ on when a tag can be set:
 *
 * - **Accept-time tags** (`accept(socket, attachment, tags)`) — mandatory.
 * Every host must accept them and must honour them in `getSockets(tag)`.
 * They are durable: a tag survives hibernation exactly like an attachment.
 * Cloudflare's `state.acceptWebSocket(ws, tags)` is this tier, and it is the
 * only tier Cloudflare supports — DO tags are immutable once accepted.
 * - **Mutable tags** ({@link SocketHost.setTag} / {@link SocketHost.removeTag})
 * — optional. Presence declares that the host can retag a live socket. Hosts
 * that cannot (Cloudflare) omit both methods, and callers that need to
 * retag must instead close and re-accept the socket with new tags.
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
     * serialized immediately and must survive host recycling. `tags` are the
     * socket's durable fan-out labels, fixed for its lifetime — they must
     * survive recycling too and must be honoured by
     * {@link SocketHost.getSockets}. Returns a handle the engine can
     * send/close through.
     */
    accept: (socket: unknown, attachment?: unknown, tags?: ReadonlyArray<string>) => SocketHandle;

    /**
     * Enumerate currently-live sockets. When `tag` is supplied the result MUST
     * contain exactly the sockets carrying that tag — never a superset.
     *
     * Exactness is a correctness requirement, not a performance one: returning
     * every socket for a tagged call would fan a shape update out to unrelated
     * subscriptions, which across tenants is a data leak. A host without
     * native tagging must therefore filter in userland over the tags it was
     * handed at {@link SocketHost.accept}.
     */
    getSockets: (tag?: string) => SocketHandle[];

    /**
     * Remove a tag from a live socket — all of them when `tag` is omitted.
     * Optional, and only meaningful alongside {@link SocketHost.setTag}: a
     * host that cannot retag a live socket must omit both.
     */
    removeTag?: (socket: SocketHandle, tag?: string) => void;

    /**
     * Tag a live socket after it was accepted. Presence of this method is the
     * host's declaration that tags are *mutable*; it is not what makes tagged
     * fan-out work, since accept-time tags are mandatory for every host. Omit
     * it (rather than supplying a no-op) when the host's tags are frozen at
     * accept, so callers re-accept instead of silently losing the retag.
     */
    setTag?: (socket: SocketHandle, tag: string) => void;
}
