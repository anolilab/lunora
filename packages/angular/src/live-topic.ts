import type { Injector, Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";

import { attachReactiveArgs, shouldOpenSubscription } from "./platform";

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
 * `LiveTopicOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface LiveTopicOptions {
    /**
     * `DestroyRef` whose `onDestroy` tears the subscription down. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /**
     * `Injector` to create the reactive-args `effect()` from. Only needed when the
     * options are a function AND `liveTopic` is called outside an injection context
     * with an explicit `destroyRef`. Unused for the static form.
     */
    injector?: Injector;
}

/**
 * Follow one live topic on the connection shared by its URL, and mirror its
 * payloads into an Angular `signal`.
 *
 * `lastEvent` reads `undefined` until the first event lands; `error` carries the
 * shard's refusal of the subscription. The subscription is torn down when the
 * owning `DestroyRef` fires, so there is no leaked subscriber.
 *
 * ```ts
 * export class PostComponent {
 *     readonly comments = liveTopic({ url: "/live/posts/connect", topic: `comments:${this.postId}` });
 * }
 * ```
 *
 * Pass a function to make it reactive: an options change (a new topic, say)
 * resubscribes, while a new `onEvent` / `onError` identity is read at call time and
 * does not reopen the subscription.
 * @experimental
 */
export const liveTopic = (
    source: SubscribeLiveTopicOptions | (() => SubscribeLiveTopicOptions),
    options: LiveTopicOptions = {},
): { error: Signal<LiveStreamSubscribeError | undefined>; lastEvent: Signal<unknown> } => {
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const lastEvent = signal<unknown>(undefined);
    const error = signal<LiveStreamSubscribeError | undefined>(undefined);

    const resolve = typeof source === "function" ? source : () => source;

    const open = (connection: LiveTopicConnection, registerCleanup: (unsubscribe: () => void) => void): void => {
        // A new topic starts clean: the previous topic's payload must not render under it.
        lastEvent.set(undefined);
        error.set(undefined);

        const unsubscribe = subscribeLiveTopic({
            ...connection,
            onError: (refusal) => {
                error.set(refusal);
                resolve().onError?.(refusal);
            },
            onEvent: (payload) => {
                lastEvent.set(payload);
                error.set(undefined);
                resolve().onEvent?.(payload);
            },
        });

        registerCleanup(unsubscribe);
    };

    // Skip the socket on the Angular server platform (SSR), as `liveQuery` does.
    if (shouldOpenSubscription(fromInjectionContext)) {
        if (typeof source === "function") {
            attachReactiveArgs(() => connectionOf(resolve()), { destroyRef, injector: options.injector }, open);
        } else {
            open(connectionOf(source), (unsubscribe) => destroyRef.onDestroy(unsubscribe));
        }
    }

    return { error: error.asReadonly(), lastEvent: lastEvent.asReadonly() };
};
