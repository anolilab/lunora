import type { Injector, Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";

import { resolveLunoraClient } from "./client";
import { attachReactiveArgs, shouldOpenSubscription } from "./platform";

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
     * `Injector` to create the reactive-args `effect()` from. Only needed when
     * `args` is a function/`Signal` AND `subscription` is called outside an
     * injection context (an explicit `destroyRef` is also being passed).
     * Defaults to the ambient injection context. Unused for the static `args`
     * form, which never creates an `effect()`.
     */
    injector?: Injector;

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
 *
 * `args` also accepts a function/`Signal` to make the subscription reactive —
 * an args change tears the old subscription down and opens a fresh one for the
 * new args. A static (plain object) `args` resolves once and never re-runs.
 * @experimental
 */
export const subscription = <F extends FunctionReference>(
    reference: F,
    args: ArgsOf<F> | "skip" | (() => ArgsOf<F> | "skip"),
    options: SubscriptionOptions = {},
): SubscriptionResult<ReturnOf<F>> => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const userOnError = options.onError;

    const data = signal<ReturnOf<F> | undefined>(undefined);
    const error = signal<SubscriptionError | undefined>(undefined);

    const open = (currentArgs: ArgsOf<F> | "skip", registerCleanup: (unsubscribe: () => void) => void): void => {
        // Reset first, don't just (re)open: under the reactive form the effect's
        // cleanup only closes the socket. Without this the consumer keeps
        // rendering the previous args' last payload (or error) under the new
        // args — or, on a `"skip"` emission, as if the subscription were still open.
        data.set(undefined);
        error.set(undefined);

        if (currentArgs === "skip") {
            return;
        }

        const unsubscribe = createQuerySubscription<F>(
            client,
            reference,
            currentArgs,
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

        registerCleanup(unsubscribe);
    };

    // The `shouldOpenSubscription()` guard skips the socket on the Angular server
    // platform (SSR): the signals stay at their initial `undefined`, and the
    // browser render re-runs this and attaches.
    if (shouldOpenSubscription(fromInjectionContext)) {
        if (typeof args === "function") {
            // Cast: TS can't rule out `ArgsOf<F>` itself being function-shaped for
            // an unconstrained generic — see `liveQuery`'s equivalent cast.
            const resolveArgs = args as () => ArgsOf<F> | "skip";

            // Reactive form — see `liveQuery`'s equivalent branch for the ordering
            // and DI rationale.
            attachReactiveArgs(resolveArgs, { destroyRef, injector: options.injector }, open);
        } else {
            open(args, (unsubscribe) => destroyRef.onDestroy(unsubscribe));
        }
    }

    return { data: data.asReadonly(), error: error.asReadonly() };
};
