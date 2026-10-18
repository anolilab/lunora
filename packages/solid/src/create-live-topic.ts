import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { trackedArgsEffect } from "./reactive-args";

/**
 * `createLiveTopic` — follow one live topic on the connection shared by its URL.
 *
 * A thin lifecycle wrapper over `subscribeLiveTopic` from `@lunora/client`: it
 * subscribes when the owner mounts, unsubscribes on cleanup, and resubscribes when
 * the url, topic or connection options change. Callbacks are not part of that
 * identity, so a new `onEvent` / `onError` never reopens the subscription.
 */

interface CreateLiveTopicResult {
    /** The shard's refusal of this subscription (403, 409, 429 and similar), or `undefined`. */
    error: Accessor<LiveStreamSubscribeError | undefined>;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: Accessor<unknown>;
}

/** The fields that decide which connection and subscription a topic needs. Callbacks are excluded. */
type LiveTopicConnection = Pick<SubscribeLiveTopicOptions, "headers" | "maxDelayMs" | "retryDelay" | "topic" | "url" | "withCredentials">;

const connectionOf = (options: SubscribeLiveTopicOptions): LiveTopicConnection => {
    return {
        headers: options.headers,
        maxDelayMs: options.maxDelayMs,
        retryDelay: options.retryDelay,
        topic: options.topic,
        url: options.url,
        withCredentials: options.withCredentials,
    };
};

/**
 * Follow `options.topic` on the shared live connection for `options.url`.
 *
 * `options` may be a plain object or an accessor. The `onEvent` and `onError`
 * callbacks are read at call time, so the latest identity is always the one invoked.
 */
const createLiveTopic = (options: SubscribeLiveTopicOptions | Accessor<SubscribeLiveTopicOptions>): CreateLiveTopicResult => {
    const resolveOptions = typeof options === "function" ? options : () => options;

    const [lastEvent, setLastEvent] = createSignal<unknown>(undefined);
    const [error, setError] = createSignal<LiveStreamSubscribeError | undefined>(undefined);

    trackedArgsEffect(
        () => connectionOf(resolveOptions()),
        (connection) => {
            // A new topic starts clean: the previous topic's payload must not render under it.
            setLastEvent(() => undefined);
            setError(() => undefined);

            return subscribeLiveTopic({
                ...connection,
                onError: (refusal) => {
                    setError(() => refusal);
                    resolveOptions().onError?.(refusal);
                },
                onEvent: (payload) => {
                    setLastEvent(() => payload);
                    setError(() => undefined);
                    resolveOptions().onEvent?.(payload);
                },
            });
        },
    );

    return { error, lastEvent };
};

export type { CreateLiveTopicResult };
export { createLiveTopic };
