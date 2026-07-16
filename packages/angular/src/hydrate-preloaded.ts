import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { FunctionReference, LunoraClient, Preloaded, SubscriptionError } from "@lunora/client";

import { resolveLunoraClient } from "./client";
import { shouldOpenSubscription } from "./platform";

/**
 * `HydratePreloadedOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface HydratePreloadedOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /** `DestroyRef` whose `onDestroy` tears the subscription down. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;
}

/**
 * `HydratePreloadedResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface HydratePreloadedResult<T> {
    /** The latest value pushed by the server. Seeded synchronously from the preloaded value. */
    data: Signal<T | undefined>;

    /** The latest subscription error, or `undefined`. */
    error: Signal<SubscriptionError | undefined>;
}

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live — the Angular half of the reactive-loader
 * handoff.
 *
 * The returned signal is seeded **synchronously** from `preloaded.value`, so the
 * very first read (during hydration) shows the server value: no loading flash,
 * no hydration mismatch. After seeding it opens a WebSocket subscription on the
 * same `(functionPath, args, shardKey)` the SSR loader used, so every later
 * server delta updates the signal exactly like `liveQuery`.
 *
 * The subscription tears down when the owning `DestroyRef` fires.
 *
 * Call from an injection context:
 * ```ts
 * readonly { data, error } = hydratePreloaded(preloadedMessages);
 * ```
 * @experimental
 */
export const hydratePreloaded = <T>(preloaded: Preloaded<T>, options: HydratePreloadedOptions = {}): HydratePreloadedResult<T> => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);

    const { args, functionPath, shardKey, value } = preloaded;

    const data = signal<T | undefined>(value);
    const error = signal<SubscriptionError | undefined>(undefined);

    const functionReference: FunctionReference = { __lunoraRef: functionPath };

    // During SSR the signal keeps its synchronous seed (`preloaded.value`) — the
    // server value renders with no loading flash — but no socket is opened. The
    // browser render re-runs this, re-seeds, and attaches the live subscription.
    if (shouldOpenSubscription(fromInjectionContext)) {
        const unsubscribe = client.subscribe(
            functionReference,
            args,
            (next) => {
                data.set(next as T);
                error.set(undefined);
            },
            {
                onError: (error_) => {
                    error.set(error_);
                },
                shardKey,
            },
        );

        destroyRef.onDestroy(unsubscribe);
    }

    return { data: data.asReadonly(), error: error.asReadonly() };
};
