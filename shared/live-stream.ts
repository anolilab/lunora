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

/**
 * The whisper-topic prefix a `defineRoom` lives under. A server publish may not name a room
 * topic: the room's members trust a frame there as its handler's output.
 */
export const ROOM_TOPIC_PREFIX = "room:";

/**
 * Prefix of the reserved whisper topic a `defineWebSocket` route's sockets join. No
 * client-supplied or published topic may address a route channel.
 */
export const SOCKET_TOPIC_PREFIX = "__lunora_socket__:";

/**
 * Longest topic or subscription id a live control call may name, and the longest topic a
 * publish may name. Both are held in the shard's memory for the life of the connection, so
 * an unbounded name is a memory lever. It applies to the ENCODED topic string.
 */
export const MAX_LIVE_CONTROL_KEY_LENGTH = 256;

/** `GET` path of a stream's SSE connection. The one place the route shape is spelled. */
export const liveConnectPath = (id: string): string => `/live/${id}/connect`;

/** `POST` path of a stream's subscribe / unsubscribe control. */
export const liveControlPath = (id: string): string => `/live/${id}/control`;

/**
 * A declared topic name or key field: an identifier. It cannot hold `:` (the segment
 * delimiter) or `%` (the escape), which is what keeps {@link encodeLiveTopic} injective.
 */
const LIVE_IDENTIFIER = /^[A-Za-z]\w*$/u;

/** Whether `name` is usable as a declared topic name or key field. */
export const isLiveIdentifier = (name: string): boolean => LIVE_IDENTIFIER.test(name);

/** Whether a topic named `name` would encode into a topic space a live publish cannot address. */
export const isReservedLiveTopicName = (name: string): boolean => `${name}:`.startsWith(ROOM_TOPIC_PREFIX) || `${name}:`.startsWith(SOCKET_TOPIC_PREFIX);

/**
 * The wire topic for a declared topic `name` and its `key`: `name` alone for a keyless
 * topic, otherwise `name:<seg>:<seg>…` with one percent-encoded segment per key field, in
 * `fields` order (the declaration's order, never the caller's object order).
 *
 * Injective: `encodeURIComponent` escapes `:`, so a segment can never hold the delimiter,
 * and a declared name cannot either. Two different `(name, key)` pairs never share a string.
 */
export const encodeLiveTopic = (name: string, fields: readonly string[], key: Readonly<Record<string, string>>): string =>
    [
        name,
        ...fields.map((field) => {
            const value = key[field];

            if (typeof value !== "string") {
                throw new TypeError(`live topic "${name}" needs a string key.${field}`);
            }

            return encodeURIComponent(value);
        }),
    ].join(":");

/**
 * Parse a raw wire topic back into its declared `(name, key)`, or `undefined` when it is
 * not exactly what {@link encodeLiveTopic} would have produced for a declared topic.
 *
 * Rejects an undeclared name, the wrong number of segments, undecodable escapes, and any
 * non-canonical spelling (`post:%31`, `post:%3a`): two raw strings that decode to the same
 * key would otherwise be two subscription-registry entries for one logical topic.
 */
export const parseLiveTopic = (
    raw: string,
    declared: Readonly<Record<string, readonly string[]>>,
): undefined | { key: Record<string, string>; name: string } => {
    if (raw.length > MAX_LIVE_CONTROL_KEY_LENGTH) {
        return undefined;
    }

    const [name, ...segments] = raw.split(":");

    if (name === undefined || !Object.hasOwn(declared, name)) {
        return undefined;
    }

    const fields = declared[name] as readonly string[];

    if (segments.length !== fields.length) {
        return undefined;
    }

    const key: Record<string, string> = {};

    try {
        for (const [index, field] of fields.entries()) {
            key[field] = decodeURIComponent(segments[index] as string);
        }

        return encodeLiveTopic(name, fields, key) === raw ? { key, name } : undefined;
    } catch {
        // A malformed escape, or a lone surrogate that cannot re-encode.
        return undefined;
    }
};

/**
 * A reference to one declared live topic, as `_generated/live.ts` hands it out. Plain data
 * (no server code), so a client bundle can hold it; the phantom `Payload` is what lets
 * `ctx.live.publish` and the framework hooks type the event.
 */
export interface LiveTopicRef<Payload = unknown> {
    /** Phantom: carries the declared payload type. Never present at runtime. */
    readonly __payload?: Payload;
    /** The `id` of the `defineLiveStream` that declares and authorizes this topic. */
    readonly __lunoraLive: string;
    /** The encoded wire topic (see {@link encodeLiveTopic}). */
    readonly topic: string;
}
