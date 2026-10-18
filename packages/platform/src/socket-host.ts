/**
 * `SocketHost` — the provider-neutral contract for hibernated WebSocket
 * subscriptions inside a shard. On Cloudflare this is backed by the Durable
 * Object WebSocket hibernation API (`state.acceptWebSocket`,
 * `ws.serializeAttachment`, `state.getWebSockets`).
 *
 * The engine relies on three guarantees:
 * 1. **Hibernation** — a socket can be evicted from memory and rehydrated
 * later without losing its subscription state.
 * 2. **Attachment round-trip** — JSON state serialized with the socket, within
 * the attachment budget below, must survive recycling and be readable on wake.
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
 *
 * **Reserved-slot budget.** A host may reserve some of its accept-time tag
 * slots for its own bookkeeping — Cloudflare's adapter prepends one identity
 * tag (so `idFor` survives hibernation) before every `acceptWebSocket` call.
 * Cloudflare's own cap is 10 tags per socket, 256 characters each
 * (developers.cloudflare.com/durable-objects/api/state/), so with one slot
 * reserved a portable caller should assume **at most 9 usable tags, each
 * bounded to at most 256 characters**. Every host refuses a budget-exceeding
 * `accept` call (see {@link SocketHost.accept}) through the check they share,
 * {@link findSocketTagBudgetViolation}, so no host accepts a socket that
 * Cloudflare would refuse.
 *
 * **Attachment budget.** Cloudflare's `serializeAttachment` caps each
 * socket's attachment at 16384 bytes; a larger value throws
 * `A WebSocket 'attachment' cannot be larger than 16384 bytes.` (measured
 * against workerd and pinned by
 * `packages/do/__tests__/workerd/shard-do.workerd.test.ts`). Portable callers
 * should keep attachments well under that.
 * Only Cloudflare enforces it, by throwing at serialize time: measuring every
 * attachment would sit on the accept and re-attach paths, which the engine
 * keeps hot, and the engine's own attachments are small by construction.
 */

/**
 * The portable accept-time tag budget every host refuses beyond. 9 usable tags
 * is Cloudflare's 10-tag `acceptWebSocket` cap minus the one identity slot its
 * adapter reserves; 256 characters is Cloudflare's per-tag cap. Verified
 * against developers.cloudflare.com/durable-objects/api/state/ (2026-08-01);
 * update these numbers and that date if the page changes.
 */
export const SOCKET_TAG_BUDGET = {
    maxTagLength: 256,
    usableTags: 9,
} as const;

/**
 * Check `tags` against {@link SOCKET_TAG_BUDGET}. Returns a human-readable
 * violation, or `undefined` when within budget. Hosts call this first in
 * `accept` and throw their own error type, so an over-budget call fails the
 * same way on every host rather than only on the one whose provider caps it.
 */
export const findSocketTagBudgetViolation = (tags?: ReadonlyArray<string>): string | undefined => {
    if (tags === undefined) {
        return undefined;
    }

    if (tags.length > SOCKET_TAG_BUDGET.usableTags) {
        return `${String(tags.length)} tags supplied; a socket accepts at most ${String(SOCKET_TAG_BUDGET.usableTags)} (Cloudflare allows 10 per socket and reserves 1 for the host's identity tag).`;
    }

    const overLength = tags.find((tag) => tag.length > SOCKET_TAG_BUDGET.maxTagLength);

    if (overLength !== undefined) {
        return `Tag ${JSON.stringify(overLength)} is ${String(overLength.length)} characters; at most ${String(SOCKET_TAG_BUDGET.maxTagLength)} are allowed per tag.`;
    }

    return undefined;
};

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
     *
     * Portable callers should assume a budget of **at most 9 usable tags, each
     * at most 256 characters** — some hosts (Cloudflare) reserve one tag slot
     * of their own 10-tag cap for bookkeeping; see this file's module-header
     * "Reserved-slot budget" note. Every host rejects an over-budget call (see
     * {@link findSocketTagBudgetViolation}) rather than accepting it and
     * silently dropping or truncating tags, which would break
     * {@link SocketHost.getSockets}'s exactness requirement.
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
     * recycle. Callers outside the O(subscribers) loops are the intended
     * consumers; do not reach for this per socket per frame.
     *
     * **Who actually calls it, since the previous wording named the wrong
     * caller.** It said "the engine uses it to reassociate a rehydrated socket
     * with its subscription state"; the engine does no such thing. Per-socket
     * state is keyed on the handle object itself (`ShardRunner.socketFor`, over
     * {@link SocketHost.handleFor}), and durable connection identity is the
     * engine's own `connectionId` — a UUID minted at upgrade and stamped onto the
     * socket attachment, which is what survives hibernation. `@lunora/shard-engine`
     * and `@lunora/do` dispatch to `handleFor`, `getSockets` and `accept`, and to
     * nothing else on this interface.
     *
     * `idFor` is the portable **identity oracle** instead: the conformance suite
     * compares sockets through it (a host is allowed to hand back a different
     * wrapper object for the same socket, so object identity is not a legal
     * assertion), and it is how a host's own recycle plumbing addresses a socket
     * by id. That is a real job and it is why this stays required — every host
     * has to answer it for the TCK regardless — but implement it as a test and
     * tooling contract, not as something on the frame path.
     *
     * **A socket this host never {@link SocketHost.accept}ed** (a foreign socket
     * the runtime hands back — a whisper sender in another pool, a relay peer)
     * is outside that "own socket" contract, but a host must still pick ONE
     * consistent answer for it, never a fresh value per call:
     *
     * - Throw, when a `SocketHandle` from this host can *only* ever originate
     * from this host's own `accept`/`recycle` — an unrecognized handle then
     * means caller error (a handle crossed from a different host instance),
     * and failing loud beats returning a plausible-looking wrong id. This is
     * the reference host's choice, since its `SocketHandle` is an opaque
     * object it mints itself.
     * - Mint and cache a read-only fallback id, when `SocketHandle` doubles as
     * the provider's own transport socket (see {@link SocketHandle}'s "not a
     * wrapper" rationale) — a foreign-but-genuine socket then structurally
     * satisfies the type without ever going through `accept`, so throwing
     * would fire on legitimate traffic, not just caller error. This is the
     * Cloudflare host's choice: it caches into a separate map from its
     * accept-time ownership evidence, so an `idFor` lookup can never promote
     * a socket into "ours" for {@link SocketHost.handleFor}.
     *
     * Either is a valid implementation as long as it is consistent: what is not
     * valid is minting a new id on every call for a socket the host does not
     * recognize, which defeats the "same string for the same socket" property
     * every caller of `idFor` — owned or not — depends on.
     */
    idFor: (socket: SocketHandle) => string;

    /**
     * Open the two ends of one connection. `server` is the end the shard
     * accepts; `client` is the end the upgrade response hands to the transport.
     * On Cloudflare this is `new WebSocketPair()`. A host without that global
     * supplies its own pair, and `upgradeResponse` must understand it.
     */
    newPair: () => { client: unknown; server: unknown };

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

    /**
     * The `101 Switching Protocols` response that carries a pair's client end.
     * Cloudflare builds it as `new Response(null, { status: 101, webSocket })`.
     * A host whose `Response` cannot carry status 101 returns its own marker,
     * which its HTTP listener recognises and completes the handshake from.
     */
    upgradeResponse: (client: unknown) => Response;
}
