import type { PollingFallback } from "./polling-fallback";
import type { ReconnectCalculator } from "./reconnect";
import type { SubscriptionState } from "./subscription";
import type { ClientMessage } from "./types";

export type WSState = "idle" | "connecting" | "open" | "closed";

/** Whether writes reach the origin: over the socket, or over HTTP while polling. */
export const isLiveStatus = (status: ConnectionStatus): boolean => status === "connected" || status === "polling";

/**
 * One WebSocket per shard key. Subscriptions and the writes they observe must
 * land on the same Durable Object, so each distinct `shardKey` gets its own
 * socket connected to `?shard=<key>` (the default shard uses no query param).
 * Reconnect backoff, offline-flush state, and the pending-unsubscribe buffer
 * are all per-connection so one shard dropping doesn't disturb the others.
 */
export interface ShardConnection {
    /**
     * Fail-fast timer armed while the socket is `connecting`; cleared on `open`.
     * If the handshake doesn't complete within `connectTimeoutMs` (a hung proxy /
     * cold worker that never upgrades) it force-closes the socket and routes
     * through the normal disconnect/reconnect path, instead of leaving the live
     * channel silently stuck on the browser's much longer default WS timeout.
     */
    connectTimer: ReturnType<typeof setTimeout> | undefined;
    /** Active keepalive interval while the socket is open; cleared on disconnect/close. */
    heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    /**
     * The `LunoraClient.identityFingerprint` captured when this connection's
     * CURRENT socket was opened (`undefined` before the first attempt).
     *
     * A WebSocket credential is pinned in the upgrade URL and cannot be rotated
     * in place, so a `setAuthToken` that switches users leaves this socket
     * authenticated as the PREVIOUS one — it would keep delivering that user's
     * rows until something closed it, which for a long time was nothing on a
     * client without `crossTabSync`. `evictPreviousIdentitySession` is that
     * something now; this stamp still matters for the frames that land in the
     * gap before the close, and for a socket the close could not reach.
     * Reading the live fingerprint when such a frame lands stamps the
     * previous user's data with the new user's identity; the durable read cache
     * (on by default in browsers) then hydrates it into the new session on the
     * next reload. Stamping what the SOCKET is authenticated as instead keeps
     * the cache's identity gate able to reject it.
     */
    identity?: string | null;

    /**
     * The `LunoraClient.identityQuestions` id this connection's CURRENT
     * socket was upgraded under, when the cookie was its only credential (no
     * bearer token held, no `?token=`). `undefined` otherwise: the `identity`
     * frame such a socket gets answers for the token, not for the cookie session
     * this client's identity tracks, and is ignored.
     */
    identityQuestion?: number;

    /**
     * Armed (non-default shards only) when the last user of this shard lets go;
     * closes the connection if nothing has picked it up again by the time it
     * fires. See `LunoraClient.releaseIdleShard`.
     */
    idleTimer?: ReturnType<typeof setTimeout>;

    /**
     * Wall-clock time (`Date.now()`) of the most recently received frame on
     * this connection's socket — ANY frame, including the plain-string
     * `lunora-pong` keepalive reply, which never reaches `handleServerMessage`'s
     * JSON parsing. Reset on every `open` so a fresh (re)connect starts its
     * watchdog window clean. The heartbeat tick force-closes a socket that's
     * gone quiet for more than `heartbeatIntervalMs * 2.5` despite reporting
     * `wsState === "open"` — a half-open socket (a proxy that swallowed the
     * close, a hibernation edge case) that would otherwise never fire `close`
     * and silently stale every live query bound to it forever.
     */
    lastFrameAt: number;

    /** Stream-start frames buffered while the socket was (re)connecting. Flushed on `open`. */
    pendingStreams?: ClientMessage[];
    /** Unsubscribes that couldn't be sent while the socket was down, each tagged with its wire type so a shape sub is torn down as `shape_unsubscribe`, never the legacy `unsubscribe`. */
    pendingUnsubscribes: { id: string; type: "shape_unsubscribe" | "unsubscribe" }[];
    /** HTTP polling fallback for this shard's live queries (see `polling-fallback.ts`). */
    readonly polling: PollingFallback;
    reconnect: ReconnectCalculator;
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Subscriptions whose `subscribe` frame is on the wire but unanswered,
     * keyed by subscription id, each holding the watchdog that frees its slot
     * if the server never replies. Its size is the live concurrency the drain
     * meters against `RESUBSCRIBE_CONCURRENCY`.
     */
    resubscribePending: Map<string, ReturnType<typeof setTimeout>>;

    /** Subscriptions waiting their turn to be re-sent on this shard (see `RESUBSCRIBE_CONCURRENCY`). */
    resubscribeQueue: SubscriptionState[];

    /**
     * Set when the client's bounce-shard-sockets sweep retires this
     * connection's socket, and cleared when a new one is pinned in its place.
     *
     * `close()` returns before the `close` event fires, so for the rest of that
     * turn `conn.socket` still points at the retired socket and the
     * `conn.socket !== socket` guard every other late-frame check relies on
     * does not hold. A frame the previous identity's socket had already put on
     * the wire therefore reached `handleServerMessage` AFTER
     * `evictPreviousIdentitySession` had blanked the subscriptions, refilled
     * them and notified whoever was subscribed by then — the new user.
     *
     * Not `conn.identity !== identityFingerprint()`: that also fires on a plain
     * sign-in from signed-out, which deliberately leaves the socket open (no
     * previous identity to retire, and a reconnect on the most common auth
     * transition there is), and would then drop every frame on a live socket
     * nothing will ever replace.
     */
    retired?: boolean;
    /** `undefined` for the default shard (connects without a `shard` param). */
    readonly shardKey: string | undefined;
    socket: undefined | WebSocket;

    /**
     * Armed on `open`; resets the reconnect backoff if the socket is STILL open
     * when it fires. Cleared on disconnect/close.
     *
     * `open` is not proof — the upgrade is accepted before the credential is
     * read. The first inbound frame is not proof either for every client: a
     * server older than the `identity` reply sends nothing back for the
     * `connect` envelope, and the keepalive pong is
     * a plain string answered by the runtime without waking the DO, so a client
     * with no active subscription may receive no JSON frame at all.
     *
     * Surviving this window is the proof. A rejected credential arrives as a
     * `TOKEN_EXPIRED` frame and a 4001 close within a round trip, well inside
     * it, and that path clears this timer before it can fire.
     */
    stableTimer: ReturnType<typeof setTimeout> | undefined;
    wasEverConnected: boolean;
    wsState: WSState;
}

/**
 * The subset of a connection's own state `LunoraClient.openManagedSocket`
 * manages directly: the live socket (the identity-guard's comparand), the
 * fail-fast connect-timeout, and the keepalive heartbeat with its half-open
 * watchdog (plan 217). `ShardConnection` satisfies this structurally, so the
 * shard socket passes itself straight through; `subscribeScheduledJobs`
 * constructs a small matching record so it inherits the same guarantees
 * instead of hand-rolling a second, divergent implementation (CLIENT-05).
 */
export interface ManagedSocketState {
    connectTimer: ReturnType<typeof setTimeout> | undefined;
    heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    lastFrameAt: number;
    socket: undefined | WebSocket;
}

/** Map a shard key to its connection-map key (the default shard uses `""`). */
export const connectionKey = (shardKey: string | undefined): string => shardKey ?? "";

/**
 * Best-effort send over a shard's WS. Returns `true` when the message was
 * handed to the socket, `false` when the caller should queue it for the
 * next reconnect.
 */
export const sendOn = (conn: ShardConnection, message: ClientMessage): boolean => {
    if (!conn.socket || conn.wsState !== "open") {
        return false;
    }

    try {
        conn.socket.send(JSON.stringify(message));

        return true;
    } catch {
        /* socket may have closed between checks; reconnect will handle it */
        return false;
    }
};

/** Send the stream-start frames queued while the socket was (re)connecting. */
export const flushPendingStreams = (conn: ShardConnection): void => {
    if (!conn.pendingStreams || conn.pendingStreams.length === 0) {
        return;
    }

    const pending = conn.pendingStreams;

    // eslint-disable-next-line no-param-reassign -- mutate the shared ShardConnection state machine in place
    conn.pendingStreams = [];

    for (const message of pending) {
        sendOn(conn, message);
    }
};

/**
 * Aggregate live-socket health across every shard connection, for a UI status
 * indicator. `idle` = no socket opened yet; `connecting` = at least one socket
 * is (re)connecting and none is open; `connected` = at least one socket is open;
 * `polling` = no socket would open, so live queries are being refreshed over HTTP
 * instead (see `polling-fallback.ts` — live but slower, and shapes
 * / streams / whispers are dark; mutations go over HTTP as they do while
 * connected); `offline` = sockets exist but all are down (between reconnect
 * attempts), and a poll could not reach the origin either.
 *
 * `polling` outranks `connecting`: while the fallback is running a reconnect is
 * still armed in the background, and reporting that attempt would flicker the
 * indicator between two states while data is in fact arriving on the slow path.
 */
export type ConnectionStatus = "connected" | "connecting" | "idle" | "offline" | "polling";
