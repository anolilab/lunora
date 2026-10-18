/**
 * `subscribeLiveTopic` — follow one live topic on a connection shared by URL.
 *
 * `connectLiveStream` opens one SSE connection per call. A page that follows a post and its
 * comments must not open one stream per topic, and a framework hook mounted ten times must not
 * either. This keeps ONE `connectLiveStream` per (url, credentials, headers), opened by the
 * first subscriber and closed after the last one leaves. Every framework adapter's live-topic
 * hook is a thin lifecycle wrapper over this, so they share connections, and behave the same.
 *
 * The close is deferred one macrotask: a React StrictMode mount → unmount → mount, or a route
 * change that unmounts one component as the next mounts, would otherwise tear the stream down
 * and reconnect it for nothing.
 */

import type { LiveTopicRef } from "../../../shared/live-stream";
import { liveConnectPath } from "../../../shared/live-stream";
import { joinUrl, withQuery } from "./client-urls";
import type { ConnectLiveStreamOptions, LiveStream, LiveStreamSubscribeError } from "./live-stream";
import { connectLiveStream } from "./live-stream";

/** Options for {@link subscribeLiveTopic}. */
interface SubscribeLiveTopicOptions extends Omit<ConnectLiveStreamOptions, "fetch"> {
    /** Called when the shard refuses this subscription (403, 409, 429 and similar). */
    onError?: (error: LiveStreamSubscribeError) => void;
    /** Called for every event on `topic`. */
    onEvent?: (payload: unknown) => void;

    /**
     * Partitions the shared connection. A cookie-authenticated stream is bound to the session that opened it, so
     * pass something that changes when the signed-in user does (a user id): a new value opens a new connection
     * and the old one closes once its subscribers have moved. It is never sent to the server.
     */
    sessionKey?: string;
    /** The topic to follow. */
    topic: string;
    /** The `connect` route URL of a `defineLiveStream`. */
    url: string;
}

interface SharedStream {
    closeTimer: ReturnType<typeof setTimeout> | undefined;
    refs: number;
    stream: LiveStream;
}

const shared = new Map<string, SharedStream>();

/** Connections are shared only when they would be configured identically. */
const keyFor = (options: SubscribeLiveTopicOptions): string =>
    JSON.stringify([
        options.url,
        options.sessionKey,
        options.withCredentials === true,
        options.retryDelay,
        options.maxDelayMs,
        Object.entries(options.headers ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
    ]);

/**
 * Follow `topic` on the shared connection for `url`.
 * @returns an unsubscribe handle; the last one out closes the connection
 */
const subscribeLiveTopic = (options: SubscribeLiveTopicOptions): (() => void) => {
    const key = keyFor(options);
    let entry = shared.get(key);

    if (entry === undefined) {
        const { headers, maxDelayMs, retryDelay, withCredentials } = options;

        entry = { closeTimer: undefined, refs: 0, stream: connectLiveStream(options.url, { headers, maxDelayMs, retryDelay, withCredentials }) };
        shared.set(key, entry);
    }

    clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    entry.refs += 1;

    const held = entry;
    // The topic itself is the id: it joins same-topic subscribers into ONE shard-side subscription (the
    // client merges handlers per id), instead of one per mounted hook against the shard's subscription
    // limit. A prefix would push a 256-character topic past the shard's 256-character id limit.
    const unsubscribe = held.stream.subscribe({ id: options.topic, onError: options.onError, onEvent: options.onEvent, topic: options.topic });
    let released = false;

    return () => {
        if (released) {
            return;
        }

        released = true;
        unsubscribe();
        held.refs -= 1;

        if (held.refs === 0) {
            held.closeTimer = setTimeout(() => {
                shared.delete(key);
                held.stream.close();
            }, 0);
        }
    };
};

/**
 * What a framework hook takes besides the topic reference: the transport tuning of
 * {@link SubscribeLiveTopicOptions}, with `onEvent` typed by the topic's declared payload.
 */
interface LiveTopicOptions<Payload = unknown> extends Omit<SubscribeLiveTopicOptions, "onEvent" | "topic" | "url"> {
    /** Called for every event on the topic. The payload is the type the topic declares. */
    onEvent?: (payload: Payload) => void;

    /**
     * Follow the topic on this shard: the connect URL gets `?shard=<key>`, and the control calls carry it too. Omit it
     * for the default shard. Publish to the same shard with `{ shardKey }`, since delivery never crosses shards.
     */
    shardKey?: string;
}

/**
 * Resolve a topic reference to the string-based options {@link subscribeLiveTopic} takes: the connect URL is the
 * stream's route under the client's base URL, and the topic is the reference's encoded wire topic. Every framework
 * hook goes through this, so they all build the same connection (and so share it).
 */
const liveTopicSubscription = <Payload>(
    client: { readonly url: string },
    ref: LiveTopicRef<Payload>,
    options: LiveTopicOptions<Payload> = {},
): SubscribeLiveTopicOptions => {
    const { onEvent, shardKey, ...transport } = options;
    const { __lunoraLive: stream, topic } = ref;

    return {
        ...transport,
        onEvent: onEvent as ((payload: unknown) => void) | undefined,
        topic,
        url: joinUrl(client.url, withQuery(liveConnectPath(stream), { shard: shardKey })),
    };
};

export { liveTopicSubscription, subscribeLiveTopic };
export type { LiveTopicOptions, SubscribeLiveTopicOptions };

export { encodeLiveTopic, type LiveTopicRef } from "../../../shared/live-stream";
