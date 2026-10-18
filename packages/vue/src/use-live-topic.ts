import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import { shallowRef, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import onScopeDisposeOrWarn from "./scope-dispose";

/** The connection-level fields: every `subscribeLiveTopic` option except the two callbacks. */
type ConnectionFields = Omit<SubscribeLiveTopicOptions, "onError" | "onEvent">;

/**
 * Options for {@link useLiveTopic}. Each connection field may be a plain value, a
 * `ref`, or a getter, so a reactive `topic` or `url` re-subscribes. The callbacks
 * are plain functions: a getter would be called by `toValue`, so they are never wrapped.
 */
type UseLiveTopicOptions = Pick<SubscribeLiveTopicOptions, "onError" | "onEvent"> & { [K in keyof ConnectionFields]: MaybeRefOrGetter<ConnectionFields[K]> };

interface UseLiveTopicResult {
    /** Set when the shard refuses the subscription (403, 409, 429 and similar). */
    error: ShallowRef<LiveStreamSubscribeError | undefined>;
    /** The last payload delivered on the topic, or `undefined` until the first event. */
    lastEvent: ShallowRef<unknown>;
}

/** Resolve every connection field to its current value, leaving the callbacks out. */
const resolveConnection = (options: UseLiveTopicOptions): ConnectionFields => {
    const connection: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(options)) {
        if (field !== "onError" && field !== "onEvent") {
            connection[field] = toValue(value as MaybeRefOrGetter<unknown>);
        }
    }

    return connection as ConnectionFields;
};

/**
 * `useLiveTopic` — follow one live topic of a `defineLiveStream` for the life of
 * the calling component's effect scope.
 *
 * A lifecycle wrapper over `subscribeLiveTopic`: the connection is shared by URL,
 * so several composables on one page still open one stream. It subscribes on
 * setup, unsubscribes when the scope disposes, and resubscribes when a reactive
 * connection field changes. Callbacks are read at call time, so they never
 * resubscribe.
 *
 * Client-only: nothing opens during SSR, and the refs stay at their initial values there.
 */
const useLiveTopic = (options: UseLiveTopicOptions): UseLiveTopicResult => {
    const lastEvent = shallowRef<unknown>(undefined);
    const error = shallowRef<LiveStreamSubscribeError | undefined>(undefined);

    if (isBrowser()) {
        const stop = watch(
            () => JSON.stringify(resolveConnection(options)),
            (_connectionKey, _previousKey, onCleanup) => {
                // A new topic or connection starts with no value and no error from the last one.
                lastEvent.value = undefined;
                error.value = undefined;

                const unsubscribe = subscribeLiveTopic({
                    ...resolveConnection(options),
                    onError: (subscribeError) => {
                        error.value = subscribeError;
                        options.onError?.(subscribeError);
                    },
                    onEvent: (payload) => {
                        lastEvent.value = payload;
                        options.onEvent?.(payload);
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
