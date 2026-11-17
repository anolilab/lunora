import type { LiveStreamSubscribeError, LiveTopicOptions, LiveTopicRef } from "@lunora/client";
import { liveTopicSubscription, subscribeLiveTopic } from "@lunora/client";
import { stableWireKey } from "@lunora/wire";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import { shallowRef, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";
import onScopeDisposeOrWarn from "./scope-dispose";

/** The connection-level fields: every {@link LiveTopicOptions} field except the two callbacks. */
type ConnectionFields = Omit<LiveTopicOptions, "onError" | "onEvent">;

/**
 * Options for {@link useLiveTopic}. Each connection field may be a plain value, a
 * `ref`, or a getter, so a reactive `shardKey` or `headers` re-subscribes. The callbacks
 * are plain functions: a getter would be called by `toValue`, so they are never wrapped.
 */
type UseLiveTopicOptions<Payload = unknown> = Pick<LiveTopicOptions<Payload>, "onError" | "onEvent"> & {
    [K in keyof ConnectionFields]: MaybeRefOrGetter<ConnectionFields[K]>;
};

interface UseLiveTopicResult<Payload = unknown> {
    /** Set when the shard refuses the subscription (403, 409, 429 and similar). */
    error: ShallowRef<LiveStreamSubscribeError | undefined>;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: ShallowRef<Payload | undefined>;
}

/** Resolve every connection field to its current value, leaving the callbacks out. */
const resolveConnection = (options: UseLiveTopicOptions<never>): ConnectionFields => {
    const connection: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(options)) {
        if (field !== "onError" && field !== "onEvent") {
            connection[field] = toValue(value as MaybeRefOrGetter<unknown>);
        }
    }

    return connection;
};

/**
 * `useLiveTopic` — follow one live topic of a `defineLiveStream` for the life of
 * the calling component's effect scope. Pass the reference `_generated/live.ts` hands
 * out (`live.posts.post({ postId })`), as a value, a `ref` or a getter: the stream's
 * route is resolved against the injected `LunoraClient`, and `lastEvent` and `onEvent`
 * are typed by the payload the topic declares.
 *
 * A lifecycle wrapper over `subscribeLiveTopic`: the connection is shared by URL,
 * so several composables on one page still open one stream. It subscribes on
 * setup, unsubscribes when the scope disposes, and resubscribes when the reference
 * or a reactive connection field changes. Callbacks are read at call time, so they
 * never resubscribe.
 *
 * Client-only: nothing opens during SSR, and the refs stay at their initial values there.
 */
const useLiveTopic = <Payload>(topic: MaybeRefOrGetter<LiveTopicRef<Payload>>, options: UseLiveTopicOptions<Payload> = {}): UseLiveTopicResult<Payload> => {
    const lastEvent = shallowRef<Payload | undefined>(undefined);
    const error = shallowRef<LiveStreamSubscribeError | undefined>(undefined);

    if (isBrowser()) {
        const client = useLunora();
        const subscriptionOf = () => liveTopicSubscription(client, toValue(topic), resolveConnection(options as UseLiveTopicOptions<never>));

        const stop = watch(
            // `stableWireKey` ignores property order, so the same headers in a new order do not resubscribe.
            () => {
                const { headers, maxDelayMs, retryDelay, sessionKey, topic: wireTopic, url, withCredentials } = subscriptionOf();

                return stableWireKey({ headers, maxDelayMs, retryDelay, sessionKey, topic: wireTopic, url, withCredentials });
            },
            (_connectionKey, _previousKey, onCleanup) => {
                // A new topic or connection starts with no value and no error from the last one.
                lastEvent.value = undefined;
                error.value = undefined;

                const unsubscribe = subscribeLiveTopic({
                    ...subscriptionOf(),
                    onError: (subscribeError) => {
                        error.value = subscribeError;
                        options.onError?.(subscribeError);
                    },
                    onEvent: (payload) => {
                        lastEvent.value = payload as Payload;
                        error.value = undefined;
                        options.onEvent?.(payload as Payload);
                    },
                });

                onCleanup(unsubscribe);
            },
            { immediate: true },
        );

        onScopeDisposeOrWarn(
            stop,
            "[@lunora/vue] useLiveTopic called with no active effect scope — its live subscription will not be closed automatically. " +
                "Call it inside setup()/an effect scope.",
        );
    }

    return { error, lastEvent };
};

export type { UseLiveTopicOptions, UseLiveTopicResult };
export { useLiveTopic };
