import type { Injector, Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type {
    LiveStreamSubscribeError,
    LiveTopicOptions as ClientLiveTopicOptions,
    LiveTopicRef,
    LunoraClient,
    SubscribeLiveTopicOptions,
} from "@lunora/client";
import { liveTopicSubscription, subscribeLiveTopic } from "@lunora/client";

import { resolveLunoraClient } from "./client";
import { attachReactiveArgs, shouldOpenSubscription } from "./platform";

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
 * `LiveTopicOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface LiveTopicOptions<Payload = unknown> extends Omit<ClientLiveTopicOptions<Payload>, "sessionKey"> {
    /**
     * The client the stream's route is resolved against. Defaults to `LUNORA_CLIENT`, read in the
     * ambient injection context, so pass it when calling outside one (with an explicit `destroyRef`).
     */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` tears the subscription down. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /**
     * `Injector` to create the reactive-args `effect()` from. Only needed when the
     * topic is a function AND `liveTopic` is called outside an injection context
     * with an explicit `destroyRef`. Unused for the static form.
     */
    injector?: Injector;

    /**
     * Partitions the shared live connection, as `sessionKey` does on `subscribeLiveTopic`: a changed value opens a new
     * connection and closes the old one. Pass a signal (or any function) to make it reactive, e.g. to move to a new
     * key on sign-out.
     */
    sessionKey?: string | (() => string | undefined);
}

/**
 * Follow one live topic on the connection shared by its stream's route, and mirror its
 * payloads into an Angular `signal`. Pass the reference `_generated/live.ts` hands out
 * (`live.posts.post({ postId })`); the route is resolved against the injected `LunoraClient`,
 * and `lastEvent` and `onEvent` are typed by the payload the topic declares.
 *
 * `lastEvent` reads `undefined` until the first event lands; `error` carries the
 * shard's refusal of the subscription. The subscription is torn down when the
 * owning `DestroyRef` fires, so there is no leaked subscriber.
 *
 * ```ts
 * export class PostComponent {
 *     readonly postId = input.required<string>();
 *
 *     readonly comments = liveTopic(() => live.posts.post({ postId: this.postId() }));
 * }
 * ```
 *
 * Pass a function when the topic reads a signal, as above: an input is not bound while a field
 * initializer runs, so a plain reference would read `this.postId` too early. A new topic, or a new
 * `sessionKey` signal value, resubscribes, while a new `onEvent` / `onError` identity is read at
 * call time and does not reopen the subscription.
 * @experimental
 */
export const liveTopic = <Payload>(
    topic: LiveTopicRef<Payload> | (() => LiveTopicRef<Payload>),
    options: LiveTopicOptions<Payload> = {},
): { error: Signal<LiveStreamSubscribeError | undefined>; lastEvent: Signal<Payload | undefined> } => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const lastEvent = signal<Payload | undefined>(undefined);
    const error = signal<LiveStreamSubscribeError | undefined>(undefined);

    const resolveTopic = typeof topic === "function" ? topic : () => topic;
    const { sessionKey } = options;
    const subscriptionOf = (): SubscribeLiveTopicOptions =>
        liveTopicSubscription(client, resolveTopic(), { ...options, sessionKey: typeof sessionKey === "function" ? sessionKey() : sessionKey });

    const open = (connection: LiveTopicConnection, registerCleanup: (unsubscribe: () => void) => void): void => {
        // A new topic starts clean: the previous topic's payload must not render under it.
        lastEvent.set(undefined);
        error.set(undefined);

        const unsubscribe = subscribeLiveTopic({
            ...connection,
            onError: (refusal) => {
                error.set(refusal);
                options.onError?.(refusal);
            },
            onEvent: (payload) => {
                lastEvent.set(payload as Payload);
                error.set(undefined);
                options.onEvent?.(payload as Payload);
            },
        });

        registerCleanup(unsubscribe);
    };

    // Skip the socket on the Angular server platform (SSR), as `liveQuery` does.
    if (shouldOpenSubscription(fromInjectionContext)) {
        if (typeof topic === "function" || typeof sessionKey === "function") {
            attachReactiveArgs(() => connectionOf(subscriptionOf()), { destroyRef, injector: options.injector }, open);
        } else {
            open(connectionOf(subscriptionOf()), (unsubscribe) => destroyRef.onDestroy(unsubscribe));
        }
    }

    return { error: error.asReadonly(), lastEvent: lastEvent.asReadonly() };
};
