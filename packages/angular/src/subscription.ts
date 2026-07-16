import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";

import { resolveLunoraClient } from "./client";
import { shouldOpenSubscription } from "./platform";

/**
 * `SubscriptionOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface SubscriptionOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * `DestroyRef` whose `onDestroy` tears the subscription down. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /**
     * Called when the subscription errors after the initial attach. Without it,
     * a post-attach failure is dropped silently.
     */
    onError?: (error: SubscriptionError) => void;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * `SubscriptionResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface SubscriptionResult<T> {
    /** The latest value pushed by the server. `undefined` before the first frame. */
    data: Signal<T | undefined>;

    /** The latest error, or `undefined`. */
    error: Signal<SubscriptionError | undefined>;
}

/**
 * Subscribe to a reactive server push stream. Returns `{ data, error }` signals
 * that update whenever the server emits a new value.
 *
 * Unlike `liveQuery`, which tracks a single value, `subscription` also
 * exposes an `error` signal for the async error channel. Use it for ephemeral,
 * high-frequency streams where you need error visibility.
 *
 * Pass `"skip"` as `args` to short-circuit — no network call, no socket.
 * The subscription tears down when the owning `DestroyRef` fires.
 *
 * Call from an injection context (component/service field or constructor):
 * ```ts
 * readonly stream = subscription(api.events.stream, { roomId: "general" });
 * ```
 * @experimental
 */
export const subscription = <F extends FunctionReference>(
    reference: F,
    args: ArgsOf<F> | "skip",
    options: SubscriptionOptions = {},
): SubscriptionResult<ReturnOf<F>> => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const data = signal<ReturnOf<F> | undefined>(undefined);
    const error = signal<SubscriptionError | undefined>(undefined);

    // The `shouldOpenSubscription()` guard skips the socket on the Angular server
    // platform (SSR): the signals stay at their initial `undefined`, and the
    // browser render re-runs this and attaches.
    if (args !== "skip" && shouldOpenSubscription(fromInjectionContext)) {
        const userOnError = options.onError;

        const unsubscribe = createQuerySubscription<F>(
            client,
            reference,
            args,
            {
                onData: (next) => {
                    data.set(next);
                    error.set(undefined);
                },
                onError: (error_) => {
                    error.set(error_);
                    data.set(undefined);
                    userOnError?.(error_);
                },
                onReset: () => {
                    data.set(undefined);
                },
            },
            { shardKey: options.shardKey },
        );

        destroyRef.onDestroy(unsubscribe);
    }

    return { data: data.asReadonly(), error: error.asReadonly() };
};
