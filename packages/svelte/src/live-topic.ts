import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import type { Readable, Unsubscriber } from "svelte/store";
import { derived, readable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { isReadableStore } from "./is-readable-store";
import { subscribeReactiveArgs } from "./subscribe-reactive-args";

/**
 * `liveTopic` — follow one live topic on the connection shared by its URL.
 *
 * A thin lifecycle wrapper over `subscribeLiveTopic` from `@lunora/client`. The
 * subscription opens when the store gets its first subscriber and closes when it
 * loses its last one, so there is no `teardown()` to call. Like the other stores
 * here, a server render subscribes and opens nothing.
 */

/** The state a `liveTopic` store holds. */
interface LiveTopicState {
    /** The shard's refusal of this subscription (403, 409, 429 and similar), or `undefined`. */
    error: LiveStreamSubscribeError | undefined;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: unknown;
}

/** The fields that decide which connection and subscription a topic needs. Callbacks are excluded. */
type LiveTopicConnection = Pick<SubscribeLiveTopicOptions, "headers" | "maxDelayMs" | "retryDelay" | "sessionKey" | "topic" | "url" | "withCredentials">;

const connectionOf = (options: SubscribeLiveTopicOptions): LiveTopicConnection => {
    return {
        headers: options.headers,
        maxDelayMs: options.maxDelayMs,
        retryDelay: options.retryDelay,
        sessionKey: options.sessionKey,
        topic: options.topic,
        url: options.url,
        withCredentials: options.withCredentials,
    };
};

/**
 * Follow `options.topic` on the shared live connection for `options.url`.
 *
 * `options` may also be a `Readable` store. A new emission resubscribes only when
 * its url, topic or connection options change; a new `onEvent` / `onError` is
 * picked up on the next call without reopening the subscription.
 */
const liveTopic = (options: SubscribeLiveTopicOptions | Readable<SubscribeLiveTopicOptions>): Readable<LiveTopicState> =>
    readable<LiveTopicState>({ error: undefined, lastEvent: undefined }, (set) => {
        // Server-render guard: the store is subscribed to during SSR, and a live
        // connection must not open there. See `subscription.ts`.
        if (!isBrowser()) {
            return undefined;
        }

        const source = isReadableStore(options) ? options : readable(options);

        // The newest callbacks. Kept apart from the connection key, so a callback
        // that changes identity alone does not reopen the subscription.
        let latest: SubscribeLiveTopicOptions | undefined;
        const stopLatest = source.subscribe((next) => {
            latest = next;
        });

        const open = (connection: LiveTopicConnection): Unsubscriber => {
            // A new topic starts clean: the previous topic's payload must not render under it.
            let lastEvent: unknown;

            set({ error: undefined, lastEvent });

            return subscribeLiveTopic({
                ...connection,
                onError: (refusal) => {
                    set({ error: refusal, lastEvent });
                    latest?.onError?.(refusal);
                },
                onEvent: (payload) => {
                    lastEvent = payload;
                    set({ error: undefined, lastEvent });
                    latest?.onEvent?.(payload);
                },
            });
        };

        const stopTopic = subscribeReactiveArgs<LiveTopicConnection>(derived(source, connectionOf), open);

        return () => {
            stopTopic();
            stopLatest();
        };
    });

export type { LiveTopicState };
export { liveTopic };
