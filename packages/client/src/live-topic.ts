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

import type { ConnectLiveStreamOptions, LiveStream, LiveStreamSubscribeError } from "./live-stream";
import { connectLiveStream } from "./live-stream";

/** Options for {@link subscribeLiveTopic}. */
interface SubscribeLiveTopicOptions extends Omit<ConnectLiveStreamOptions, "fetch"> {
    /** Called when the shard refuses this subscription (403, 409, 429 and similar). */
    onError?: (error: LiveStreamSubscribeError) => void;
    /** Called for every event on `topic`. */
    onEvent?: (payload: unknown) => void;
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
    JSON.stringify([options.url, options.withCredentials === true, options.retryDelay, options.maxDelayMs, Object.entries(options.headers ?? {}).toSorted()]);

/**
 * Follow `topic` on the shared connection for `url`.
 * @returns an unsubscribe handle; the last one out closes the connection
 */
const subscribeLiveTopic = (options: SubscribeLiveTopicOptions): (() => void) => {
    const key = keyFor(options);
    let entry = shared.get(key);

    if (entry === undefined) {
        const { onError: _onError, onEvent: _onEvent, topic: _topic, url, ...connectOptions } = options;

        entry = { closeTimer: undefined, refs: 0, stream: connectLiveStream(url, connectOptions) };
        shared.set(key, entry);
    }

    clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    entry.refs += 1;

    const held = entry;
    const unsubscribe = held.stream.subscribe({ onError: options.onError, onEvent: options.onEvent, topic: options.topic });
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

export { subscribeLiveTopic };
export type { SubscribeLiveTopicOptions };
