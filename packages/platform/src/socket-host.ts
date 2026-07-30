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

/**
 * The socket the engine sends through.
 *
 * Deliberately **not** a wrapper object. A host is expected to return its own
 * transport socket here, unchanged — which is why identity lives out-of-band on
 * {@link SocketHost.idFor} rather than as an `id` property on this interface.
 *
 * Two reasons, one measured and one structural:
 *
 * 1. **Fan-out is O(subscribers) and this interface is on that loop.** Whisper
 * delivery, shape pokes and delta delivery all walk every socket calling
 * `deserializeAttachment` then `send`. When those forwarded through a wrapper,
 * the two extra call frames per socket cost +1.11 ns/socket — +11% to +13% on
 * whisper fan-out at 128 and 1024 subscribers, against a per-socket body of
 * only ~6-7 ns. An `id` property is the only thing a wrapper was needed for,
 * and it is read a handful of times outside the hot loops.
 * 2. **A wrapper creates two identities for one socket.** Enumeration would
 * yield handles while the runtime's own message/close callbacks yield the
 * transport socket, so every per-socket `WeakMap` memo could key on either and
 * diverge. Returning the transport socket collapses that: there is one object,
 * so {@link SocketHost.handleFor} is an ownership test rather than a
 * translation, and the memos cannot disagree.
 *
 * A host whose transport genuinely cannot satisfy this shape may still wrap —
 * nothing here forbids it — but it pays the per-socket cost itself instead of
 * charging every other host for it.
 */
export interface SocketHandle {
    /**
     * Bytes queued for send but not yet flushed, when the transport reports it.
     *
     * The engine polls this to apply backpressure before pushing another batch
     * at a slow subscriber. Optional because not every transport exposes a
     * queue depth — absent means "assume drained", which degrades to the
     * pre-backpressure behavior rather than stalling.
     */
    readonly bufferedAmount?: number;
    /** Close the socket with an optional code and reason. */
    close: (code?: number, reason?: string) => void;
    /** Read the attachment previously stored with `serializeAttachment`. */
    deserializeAttachment: () => unknown;
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
     * Resolve a raw socket the runtime handed back — to a message or close
     * callback, which carry the transport's own object rather than a handle —
     * to the handle the host issued for it at {@link SocketHost.accept}.
     *
     * Without this the two worlds never meet: enumeration yields handles while
     * event callbacks yield raw sockets, and code that has to compare the two
     * (excluding a sender from its own broadcast, say) is forced back onto the
     * provider type. Returns `undefined` for a socket this host never accepted.
     */
    handleFor: (socket: unknown) => SocketHandle | undefined;

    /**
     * The socket's unique identifier, stable across hibernation.
     *
     * Out-of-band rather than a property on {@link SocketHandle} so a host can
     * return its transport socket unchanged — see the note there for why that
     * matters on the fan-out path. A host supplies identity however it can: a
     * durable tag minted at accept (Cloudflare), a registry key, a `WeakMap`.
     *
     * Must answer consistently for the same socket within a wake AND across a
     * recycle, since the engine uses it to reassociate a rehydrated socket with
     * its subscription state. Callers outside the O(subscribers) loops are the
     * intended consumers; do not reach for this per socket per frame.
     */
    idFor: (socket: SocketHandle) => string;

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
