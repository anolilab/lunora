import { LunoraError } from "@lunora/errors";

import { WS_KEEPALIVE_PING } from "./client-paths";
import type { ManagedSocketState } from "./connection-state";

/** Everything a connection attempt needs from the client, passed explicitly so the lifecycle has no hidden coupling to the class. */
interface ManagedSocketOptions {
    connectTimeoutMs: number;
    heartbeatIntervalMs: number;
    WebSocketImpl: typeof WebSocket | undefined;
}

/** Clear a connection's keepalive timer, if any. Safe to call repeatedly. */
const stopHeartbeat = (conn: ManagedSocketState): void => {
    if (conn.heartbeatTimer !== undefined) {
        clearInterval(conn.heartbeatTimer);
        // eslint-disable-next-line no-param-reassign -- mutate the shared connection record to release the timer
        conn.heartbeatTimer = undefined;
    }
};

/**
 * Begin the keepalive heartbeat on an open connection attempt — the only
 * caller is {@link openManagedSocket}'s own `open` handler, so both the
 * shard socket and `subscribeScheduledJobs` share this one implementation
 * instead of each hand-rolling their own .
 *
 * Each tick first checks the half-open watchdog (see
 * {@link ManagedSocketState.lastFrameAt}): if no frame at all has arrived
 * within `heartbeatIntervalMs * 2.5`, the far end has gone quiet without
 * the socket ever firing `close` — force it closed and report it through
 * `onWatchdogTrip` (the caller's `onClose`) so the normal reconnect/backoff
 * takes over instead of every live query on it silently staling forever.
 * Otherwise it sends a {@link WS_KEEPALIVE_PING} text frame the server
 * answers from its hibernation auto-response without waking the DO. A
 * no-op when the heartbeat is disabled (an interval of zero or less);
 * idempotent — any existing timer is cleared first so a reconnect can't
 * leak intervals.
 */
const startHeartbeat = (conn: ManagedSocketState, heartbeatIntervalMs: number, onWatchdogTrip: () => void): void => {
    stopHeartbeat(conn);

    if (heartbeatIntervalMs <= 0) {
        return;
    }

    // eslint-disable-next-line no-param-reassign -- store the timer on the shared connection record so stopHeartbeat can clear it
    conn.heartbeatTimer = setInterval(() => {
        if (!conn.socket) {
            return;
        }

        const { socket } = conn;

        if (Date.now() - conn.lastFrameAt > heartbeatIntervalMs * 2.5) {
            // Mirrors the fail-fast connect-timeout pattern in
            // `openManagedSocket`: a stuck socket may throw on close, but
            // the watchdog-trip report below still arms reconnect either way.
            try {
                socket.close();
            } catch {
                /* a stuck socket may throw on close — the report below still arms reconnect */
            }

            onWatchdogTrip();

            return;
        }

        try {
            socket.send(WS_KEEPALIVE_PING);
        } catch {
            // A send race against a closing socket is harmless — the close
            // handler will tear the heartbeat down.
        }
    }, heartbeatIntervalMs);
};

/**
 * Construct one WebSocket connection attempt and wire the shared
 * lifecycle guarantees around it — the fail-fast connect-timeout, the
 * identity guard that stops a superseded attempt's late `open`/`message`/
 * `close`/`error` from touching a connection a newer attempt already
 * owns, and (once open) the keepalive heartbeat with its half-open
 * watchdog . One call opens ONE attempt; the caller owns
 * reconnect scheduling from `onClose` — mirrors the shard's existing
 * `ensureSocket` / `handleDisconnect` split, now shared with
 * `subscribeScheduledJobs` so it stops re-living the bug that split
 * already fixed once .
 *
 * The identity guard is `conn.socket !== socket`, re-checked before every
 * action below. `conn.socket` is reassigned to a new attempt's socket
 * synchronously — right here, before `open` ever fires — so an older
 * attempt's guard trips the instant it's superseded, even if its
 * underlying socket only fires its real `close`/`error` much later. This
 * ordering is load-bearing: preserve it exactly.
 */
const openManagedSocket = (
    conn: ManagedSocketState,
    url: string,
    options: ManagedSocketOptions,
    handlers: {
        onClose: (event?: { code?: number }) => void;
        onMessage: (event: MessageEvent) => void;
        /** Optional: the scheduled-jobs socket has nothing to do on `open` (its backoff resets on the first payload frame, not here). */
        onOpen?: () => void;
    },
): void => {
    const { WebSocketImpl, connectTimeoutMs, heartbeatIntervalMs } = options;

    if (WebSocketImpl === undefined) {
        // Unreachable: every caller already checked `WebSocketImpl
        // !== undefined` before reaching here.
        throw new LunoraError("INTERNAL", "no WebSocket implementation available");
    }

    // Intentional mutation of the shared, caller-owned connection record
    // so the handlers below and the caller's own bookkeeping observe the
    // same state machine (mirrors `handleDisconnect`).
    /* eslint-disable no-param-reassign -- mutate the shared connection state machine in place */
    const socket = new WebSocketImpl(url);

    conn.socket = socket;

    /** Generic teardown shared by every disconnect trigger below (timeout, close, error): stop the heartbeat and release this attempt's identity slot so a later real event on this same socket is ignored. */
    const teardown = (): void => {
        stopHeartbeat(conn);

        if (conn.connectTimer !== undefined) {
            clearTimeout(conn.connectTimer);
            conn.connectTimer = undefined;
        }

        if (conn.socket === socket) {
            conn.socket = undefined;
        }
    };

    /** The two-step disconnect sequence every trigger below runs: tear down this attempt's bookkeeping, then hand the (optional) close event to the caller. */
    const disconnect = (event?: { code?: number }): void => {
        teardown();
        handlers.onClose(event);
    };

    // Fail-fast connect timeout: if the handshake doesn't reach `open`
    // within `connectTimeoutMs` (a hung proxy / cold worker that never
    // upgrades), force-close the socket and report it through `onClose`
    // so the caller's normal reconnect/backoff takes over — instead of
    // the live channel hanging on the browser's much longer default.
    // Cleared on `open`/disconnect.
    if (connectTimeoutMs > 0) {
        conn.connectTimer = setTimeout(() => {
            conn.connectTimer = undefined;

            // Only act if THIS socket is still the connection's current
            // one. A newer reconnect socket (or an already-resolved
            // open/close) must be left untouched. `conn.socket !== socket`
            // alone is sufficient here (no additional `wsState !==
            // "connecting"` check needed): `open` below clears
            // `connectTimer` synchronously, before setting `wsState =
            // "open"`, so once a socket has reached `open` this timer can
            // never fire for it — it was already cancelled.
            if (conn.socket !== socket) {
                return;
            }

            try {
                socket.close();
            } catch {
                /* a stuck socket may throw on close — onClose below still arms reconnect */
            }

            disconnect();
        }, connectTimeoutMs);
    }

    socket.addEventListener("open", (): void => {
        // Ignore a late event from a socket that's no longer the connection's
        // current one — a timed-out/closed socket must never resurrect itself
        // or stomp the state of the newer socket that replaced it.
        if (conn.socket !== socket) {
            return;
        }

        if (conn.connectTimer !== undefined) {
            clearTimeout(conn.connectTimer);
            conn.connectTimer = undefined;
        }

        // Fresh (re)connect — start the half-open watchdog window clean
        // rather than carrying over a stale timestamp from before a
        // disconnect/reconnect cycle.
        conn.lastFrameAt = Date.now();

        // A WS listener that throws unwinds into the host's event loop,
        // where nothing can recover it — the rest of `onOpen` (resubscribe,
        // queued unsubscribes, stream flush, whisper rejoin, offline-queue
        // flush) is skipped and the client still reports `connected`. The
        // legs are individually throw-free today (args are pre-encoded at
        // subscribe time, every send goes through `sendOn`); this is the
        // containment that keeps a future one from silently killing a
        // reconnect. Same guard on `message` below.
        try {
            handlers.onOpen?.();
        } catch (error) {
            // eslint-disable-next-line no-console -- last-resort visibility for a throw that would otherwise vanish into the event loop
            console.error("[lunora] connection open handler threw", error);
        }

        startHeartbeat(conn, heartbeatIntervalMs, disconnect);
    });

    socket.addEventListener("message", (event: MessageEvent): void => {
        // Ignore a late message from a socket the connection already moved
        // past (see `open`/`close`/`error` above) — without this guard a
        // stale socket's frame would stamp the newer socket's `lastFrameAt`
        // and defeat the heartbeat watchdog.
        if (conn.socket !== socket) {
            return;
        }

        // Any inbound frame — including the plain-string `lunora-pong`
        // keepalive reply, which `handleServerMessage`'s JSON.parse guard
        // silently drops — proves the socket is still alive. Stamp it
        // unconditionally, before delegating to the caller's handler, so
        // the heartbeat watchdog (see `startHeartbeat`) can tell a
        // half-open socket from a healthy one. One writer, co-located
        // with the reader below, for every caller of this helper.
        conn.lastFrameAt = Date.now();

        try {
            handlers.onMessage(event);
        } catch (error) {
            // See the `open` listener above. Frame handlers that can fail on
            // hostile/corrupt input route their own failure to the affected
            // subscriber (see `handleDataMessage`); this catches whatever is
            // left so one bad frame cannot take the socket's listener down.
            // eslint-disable-next-line no-console -- last-resort visibility for a throw that would otherwise vanish into the event loop
            console.error("[lunora] server frame handler threw", error);
        }
    });

    socket.addEventListener("close", (event?: { code?: number }): void => {
        // Ignore a late close from a socket the connection already moved past
        // (e.g. the fail-fast timeout force-closed it and a reconnect already
        // built a newer socket). Acting on it would tear down the live socket.
        if (conn.socket !== socket) {
            return;
        }

        disconnect(event);
    });

    socket.addEventListener("error", (): void => {
        // Ignore a late error from a superseded socket (see `close` above):
        // only the connection's current socket may drive a disconnect.
        if (conn.socket !== socket) {
            return;
        }

        // Some WebSocket implementations (notably misbehaving proxies and
        // certain test doubles) fire `error` without a follow-up `close`.
        // Report it through `onClose` too so the caller's reconnect always
        // arms; `onClose` is idempotent downstream (mirrors
        // `handleDisconnect`'s `wsState === "idle"` checks).
        disconnect();
    });
    /* eslint-enable no-param-reassign */
};

export { openManagedSocket, stopHeartbeat };
export type { ManagedSocketOptions };
