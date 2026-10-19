import type { LiveStreamSubscribeError, LiveTopicOptions, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { liveTopicSubscription, subscribeLiveTopic } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";
import { trackedArgsEffect } from "./reactive-args";

/**
 * `createLiveTopic` — follow one live topic on the connection shared by its URL.
 *
 * A thin lifecycle wrapper over `subscribeLiveTopic` from `@lunora/client`: it
 * subscribes when the owner mounts, unsubscribes on cleanup, and resubscribes when
 * the topic or the connection options change. Callbacks are not part of that
 * identity, so a new `onEvent` / `onError` never reopens the subscription.
 */

interface CreateLiveTopicResult<Payload = unknown> {
    /** The shard's refusal of this subscription (403, 409, 429 and similar), or `undefined`. */
    error: Accessor<LiveStreamSubscribeError | undefined>;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: Accessor<Payload | undefined>;
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
 * Follow the topic `topic` names on the live connection shared by its stream's route. Pass the
 * reference `_generated/live.ts` hands out (`live.posts.post({ postId })`), plain or as an
 * accessor; the route is resolved against the `LunoraClient` from the nearest `LunoraContext`,
 * and `lastEvent` and `onEvent` are typed by the payload the topic declares.
 *
 * `options` may be a plain object or an accessor. The `onEvent` and `onError` callbacks are
 * read at call time, so the latest identity is always the one invoked.
 */
const createLiveTopic = <Payload>(
    topic: LiveTopicRef<Payload> | Accessor<LiveTopicRef<Payload>>,
    options: LiveTopicOptions<Payload> | Accessor<LiveTopicOptions<Payload>> = {},
): CreateLiveTopicResult<Payload> => {
    const client = useLunora();
    const resolveTopic = typeof topic === "function" ? topic : () => topic;
    const resolveOptions = typeof options === "function" ? options : () => options;
    const resolveSubscription = (): SubscribeLiveTopicOptions => liveTopicSubscription(client, resolveTopic(), resolveOptions());

    const [lastEvent, setLastEvent] = createSignal<Payload | undefined>(undefined);
    const [error, setError] = createSignal<LiveStreamSubscribeError | undefined>(undefined);

    trackedArgsEffect(
        () => connectionOf(resolveSubscription()),
        (connection) => {
            // A new topic starts clean: the previous topic's payload must not render under it.
            setLastEvent(() => undefined);
            setError(() => undefined);

            return subscribeLiveTopic({
                ...connection,
                onError: (refusal) => {
                    setError(() => refusal);
                    resolveSubscription().onError?.(refusal);
                },
                onEvent: (payload) => {
                    setLastEvent(() => payload as Payload);
                    setError(() => undefined);
                    resolveSubscription().onEvent?.(payload);
                },
            });
        },
    );

    return { error, lastEvent };
};

export type { CreateLiveTopicResult };
export { createLiveTopic };
