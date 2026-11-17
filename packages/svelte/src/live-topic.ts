import type { LiveStreamSubscribeError, LiveTopicOptions, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { liveTopicSubscription, subscribeLiveTopic } from "@lunora/client";
import type { Readable, Unsubscriber } from "svelte/store";
import { derived, readable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { getLunoraClient } from "./context";
import { isReadableStore } from "./is-readable-store";
import { subscribeReactiveArgs } from "./subscribe-reactive-args";

/**
 * `liveTopic` — follow one live topic on the connection shared by its stream's route.
 *
 * A thin lifecycle wrapper over `subscribeLiveTopic` from `@lunora/client`. The
 * subscription opens when the store gets its first subscriber and closes when it
 * loses its last one, so there is no `teardown()` to call. Like the other stores
 * here, a server render subscribes and opens nothing.
 *
 * The `LunoraClient` is read from context when `liveTopic` is CALLED, so call it while a
 * component initialises: `getContext` throws outside that window.
 */

/** The state a `liveTopic` store holds. */
interface LiveTopicState<Payload = unknown> {
    /** The shard's refusal of this subscription (403, 409, 429 and similar), or `undefined`. */
    error: LiveStreamSubscribeError | undefined;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: Payload | undefined;
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
 * Follow the topic `topic` names on the shared live connection for its stream's route. Pass the
 * reference `_generated/live.ts` hands out (`live.posts.post({ postId })`), or a `Readable` of one.
 * `options` may be a `Readable` too, e.g. to move to a new `sessionKey` on sign-out. A new emission
 * resubscribes only when the topic or the connection options (including `sessionKey`) change;
 * `onEvent` and `onError` are read at call time, so a new identity never reopens the subscription.
 * The route is resolved against the `LunoraClient` from context, and `lastEvent` and `onEvent` are
 * typed by the payload the topic declares.
 */
const liveTopic = <Payload>(
    topic: LiveTopicRef<Payload> | Readable<LiveTopicRef<Payload>>,
    options: LiveTopicOptions<Payload> | Readable<LiveTopicOptions<Payload>> = {},
): Readable<LiveTopicState<Payload>> => {
    // Read synchronously: `readable`'s start callback runs on the first subscribe, which may be outside component init.
    const client = getLunoraClient();

    return readable<LiveTopicState<Payload>>({ error: undefined, lastEvent: undefined }, (set) => {
        // Server-render guard: the store is subscribed to during SSR, and a live
        // connection must not open there. See `subscription.ts`.
        if (!isBrowser()) {
            return undefined;
        }

        const topicSource = isReadableStore(topic) ? topic : readable(topic);
        const optionsSource = isReadableStore(options) ? options : readable(options);

        // The newest callbacks. Kept apart from the connection key, so a callback
        // that changes identity alone does not reopen the subscription.
        let latest: LiveTopicOptions<Payload> = {};
        const stopLatest = optionsSource.subscribe((next) => {
            latest = next;
        });

        const open = (connection: LiveTopicConnection): Unsubscriber => {
            // A new topic starts clean: the previous topic's payload must not render under it.
            let lastEvent: Payload | undefined;

            set({ error: undefined, lastEvent });

            return subscribeLiveTopic({
                ...connection,
                onError: (refusal) => {
                    set({ error: refusal, lastEvent });
                    latest.onError?.(refusal);
                },
                onEvent: (payload) => {
                    lastEvent = payload as Payload;
                    set({ error: undefined, lastEvent });
                    latest.onEvent?.(payload as Payload);
                },
            });
        };

        const stopTopic = subscribeReactiveArgs<LiveTopicConnection>(
            derived([topicSource, optionsSource], ([reference, current]) => connectionOf(liveTopicSubscription(client, reference, current))),
            open,
        );

        return () => {
            stopTopic();
            stopLatest();
        };
    });
};

export type { LiveTopicState };
export { liveTopic };
