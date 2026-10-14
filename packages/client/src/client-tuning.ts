/** Default heartbeat cadence (ms) — see `LunoraClientOptions.heartbeatIntervalMs`. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default WS connect timeout (ms) — see `LunoraClientOptions.connectTimeoutMs`. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How often the HTTP polling fallback re-runs the live queries on a shard whose
 * socket will not open. Five seconds trades freshness against load deliberately:
 * a poll re-runs every subscribed query against the origin with no CDC cursor to
 * shortcut it, so a tighter interval multiplies real query cost on a link that is
 * already degraded.
 */
const DEFAULT_POLLING_FALLBACK_INTERVAL_MS = 5000;

/**
 * Consecutive connect attempts that must fail to reach `open` before the polling
 * fallback engages. Three, so a cold Worker start, a deploy bounce, or one
 * unlucky `connectTimeoutMs` does not move a healthy client onto the slow path.
 */
const DEFAULT_POLLING_FALLBACK_AFTER_FAILED_ATTEMPTS = 3;

/**
 * Debounce window (ms) for durable read-cache writes (Pillar 2). A burst of
 * deltas on one subscription coalesces into a single `put` per key after the
 * socket settles, keeping IndexedDB off the per-frame hot path.
 */
const QUERY_CACHE_DEBOUNCE_MS = 250;

/**
 * How long a socket must stay open before its reconnect backoff is reset.
 *
 * Comfortably longer than a credential rejection takes: the server accepts the
 * upgrade, reads the credential on the first frame, then sends `TOKEN_EXPIRED`
 * and closes 4001 — all within a round trip. Anything still open after this has
 * demonstrably been accepted.
 */
const SOCKET_STABLE_MS = 5000;

/**
 * How long a non-default shard's socket stays open after the last thing using
 * it lets go. Long enough that re-pointing a subscription away from a shard and
 * straight back (A→B→A) reuses the socket instead of reconnecting.
 */
const IDLE_SHARD_CLOSE_MS = 5000;

/**
 * Maximum number of stream-start frames queued per connection while the
 * socket is (re)connecting. Past this cap, the oldest queued stream is
 * evicted (its consumer is failed with `STREAM_QUEUE_OVERFLOW`) so a stuck
 * reconnect can never grow the queue unbounded.
 */
const MAX_PENDING_STREAMS = 64;

/**
 * How many `subscribe` frames a reconnect may have on the wire at once, per
 * shard, before it waits for a reply.
 *
 * Every re-subscribe runs its query server-side to build the initial snapshot,
 * and most apps put most queries on the default `__root__` shard — so sending
 * all of them in one tick lands the whole burst on a single Durable Object.
 * Three is the width measured to keep a local dev backend up where an unpaced
 * burst of ~11 crash-looped it (issue #796); it costs at most a round trip per
 * three subscriptions to restore live data.
 */
const RESUBSCRIBE_CONCURRENCY = 3;

/**
 * How long one sent-but-unanswered `subscribe` holds its slot in the drain
 * before the next one goes out without it.
 *
 * The drain must never be able to wedge: a client that silently stops
 * re-subscribing loses live data, which is worse than the burst this paces.
 * Any frame bearing the subscription's id releases its slot immediately, so
 * this deadline only fires when the server answered nothing at all.
 */
const RESUBSCRIBE_ACK_TIMEOUT_MS = 10_000;

/**
 * How many identities keep a cached mutator watermark. The nesting exists so
 * signing back into a previous identity recovers its watermark rather than
 * re-deriving `1` against a server watermark already past it (the `OUT_OF_ORDER`
 * wedge), so this can't be 1 — but it is unbounded without a cap, and only the
 * few most recent identities of a session are ever signed back into.
 */
const MAX_WATERMARK_IDENTITIES = 8;

export {
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    DEFAULT_POLLING_FALLBACK_AFTER_FAILED_ATTEMPTS,
    DEFAULT_POLLING_FALLBACK_INTERVAL_MS,
    IDLE_SHARD_CLOSE_MS,
    MAX_PENDING_STREAMS,
    MAX_WATERMARK_IDENTITIES,
    QUERY_CACHE_DEBOUNCE_MS,
    RESUBSCRIBE_ACK_TIMEOUT_MS,
    RESUBSCRIBE_CONCURRENCY,
    SOCKET_STABLE_MS,
};
