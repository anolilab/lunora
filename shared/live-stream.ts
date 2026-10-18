/**
 * Live topic streams — the shared wire vocabulary for the SSE transport.
 *
 * Sits in `shared/` rather than a package because three packages need to agree
 * on the exact strings without an edge between them: `@lunora/do` serves the
 * endpoints, `@lunora/server` forwards to them, and `@lunora/runtime` publishes
 * through them. `@lunora/runtime` treats `@lunora/shard-engine` as a peer and
 * imports it for types only, so a value export there would create exactly the
 * runtime dependency edge this avoids.
 *
 * A live stream lets server code publish an arbitrary event to a named topic
 * (`ctx.live.publish`) and lets a browser follow several topics over ONE
 * Server-Sent Events connection. The subscriber registry IS the shard Durable
 * Object. A live event also reaches a WebSocket whisper member of the same topic
 * that holds a live grant for the publishing stream (`deliverLiveLocal`). The
 * grant comes only from the control route, after `onSubscribe`. SSE connections
 * and sockets are local to the DO they connected to. The owner's relays do carry
 * live control calls and published frames for their own shard, so a whisper
 * member held by a relay still receives an event it was granted.
 */

/** Internal shard DO path serving a live SSE connection (`GET`). */
export const LIVE_CONNECT_PATH = "/_lunora/live/connect";

/** Internal shard DO path for subscribe / unsubscribe control (`POST`). A browser reaches it through `defineLiveStream`. */
export const LIVE_CONTROL_PATH = "/_lunora/live/control";

/** Internal shard DO path for a server publish (`POST`). Only `ctx.live.publish` reaches it; `defineLiveStream` never mounts it. */
export const LIVE_PUBLISH_PATH = "/_lunora/live/publish";

/**
 * The key a live subscription is held under on the shard. It is scoped by the
 * stream that authorized the topic, so a public stream cannot tap a topic a
 * private stream granted: a publish reaches only the subscribers of its own
 * stream. JSON keeps the pair unambiguous whatever characters either side holds.
 */
export const liveSubscriptionKey = (stream: string, topic: string): string => JSON.stringify([stream, topic]);

/**
 * Response header carrying the server-minted connection id on a live SSE
 * response. The client echoes it on every control request so a subscribe is
 * scoped to ONE stream rather than to the caller's whole session.
 */
export const LIVE_CONNECTION_HEADER = "x-lunora-live-connection";

/** SSE `event:` name for a delivered live payload. */
export const LIVE_EVENT_NAME = "live";

/**
 * Headers on a live SSE response. The same uncacheable set the typed `.stream()`
 * route uses, so a proxy never coalesces or buffers live frames.
 */
export const LIVE_SSE_HEADERS: Record<string, string> = {
    "cache-control": "no-cache, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
};

/**
 * Format one live SSE frame. `dataJson` is the already-serialized, wire-encoded
 * payload (the producer encodes once so a `bigint`/`Uint8Array` survives); the
 * topic rides alongside it so the client can route one multiplexed stream to the
 * right subscription. The payload is embedded verbatim — re-parsing it here
 * would only risk a lossy round-trip.
 */
export const encodeLiveFrame = (topic: string, dataJson: string): string =>
    `event: ${LIVE_EVENT_NAME}\ndata: {"topic":${JSON.stringify(topic)},"data":${dataJson}}\n\n`;
