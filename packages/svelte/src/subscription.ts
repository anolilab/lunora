import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, Unsubscribe } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import { LunoraError } from "@lunora/errors";
import type { Readable } from "svelte/store";
import { readable, writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";
import type { ReactiveArgs } from "./query";
import { subscribeReactiveArgs } from "./subscribe-reactive-args";

interface SubscriptionStoreOptions {
    onError?: (error: Error) => void;
    shardKey?: string;
}

interface SubscriptionHandle<T> {
    /** Svelte readable store of the latest server-pushed value (`undefined` until the first push). */
    data: Readable<T | undefined>;
    /** Svelte readable store of the latest subscription error (`undefined` when healthy). */
    error: Readable<Error | undefined>;
}

/**
 * Create a pair of Svelte readable stores that open a live subscription
 * against the Lunora backend. `data` updates on every server push; `error`
 * captures the last subscription error. Both stores are lazy: the
 * subscription opens on the first browser-side subscriber to `data` and tears
 * down when it stops. A server render subscribes too (svelte resolves `{$store}`
 * that way) and opens nothing.
 *
 * Passing `"skip"` as `args` keeps the stores connected but the subscription
 * dormant (`data` stays `undefined`). Pass an explicit `client` as the first
 * argument to bypass the ambient context (useful in tests).
 *
 * `args` may also be a `Readable` store: each emission tears down the previous
 * subscription, resets `data` to `undefined`, and opens a fresh one; a `"skip"`
 * emission tears down without re-opening.
 */
function subscription<F extends FunctionReference>(function_: F, args: ReactiveArgs<F>, options?: SubscriptionStoreOptions): SubscriptionHandle<ReturnOf<F>>;
function subscription<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: ReactiveArgs<F>,
    options?: SubscriptionStoreOptions,
): SubscriptionHandle<ReturnOf<F>>;
function subscription<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArgs: F | ReactiveArgs<F>,
    argsOrOptions?: SubscriptionStoreOptions | ReactiveArgs<F>,
    maybeOptions?: SubscriptionStoreOptions,
): SubscriptionHandle<ReturnOf<F>> {
    // Resolve overloads: when the second argument is a FunctionReference, the
    // first must be an explicit LunoraClient; otherwise use the ambient context.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArgs : clientOrFunction) as F;
    const args = (hasExplicitClient ? argsOrOptions : functionOrArgs) as ReactiveArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : (argsOrOptions as SubscriptionStoreOptions | undefined)) ?? {};

    const { shardKey, onError } = options;

    // A writable error store that the data store's start/stop callback pushes into.
    const errorStore = writable<Error | undefined>();

    const data = readable<ReturnOf<F> | undefined>(undefined, (set) => {
        // Server-render guard: svelte's server runtime subscribes to `{$store}`
        // during `render()`, so this start callback runs on the server too. See
        // `query.ts` for why opening there is wrong (and, on a relative-URL
        // client, throws out of the render).
        if (!isBrowser()) {
            return () => {};
        }

        // `createQuerySubscription` owns the `"skip"` sentinel: on skip it fires
        // `onReset` (clearing `data`) and returns a no-op teardown without opening
        // a socket — so the reset path below is reachable, unlike a local early
        // return that would make it dead code.
        const open = (resolved: ArgsOf<F> | "skip"): Unsubscribe => {
            // Each emission starts from a clean slate: drop the value and error
            // the previous args produced before opening the new subscription.
            set(undefined);
            errorStore.set(undefined);

            return createQuerySubscription(
                client,
                functionRef,
                resolved,
                {
                    onData: (value: ReturnOf<F>) => {
                        set(value);
                        errorStore.set(undefined);
                    },
                    onError: (subscriptionError) => {
                        // Preserve the server-supplied `code` (matching Vue/Solid's
                        // subscription primitives) so consumers can branch on it.
                        const error =
                            subscriptionError.code === undefined
                                ? new Error(subscriptionError.message)
                                : new LunoraError(subscriptionError.code, subscriptionError.message);

                        errorStore.set(error);
                        onError?.(error);
                    },
                    onReset: () => {
                        set(undefined);
                    },
                },
                { shardKey },
            );
        };

        const stopArgs = subscribeReactiveArgs<ArgsOf<F> | "skip">(args, open);

        return () => {
            stopArgs();
            errorStore.set(undefined);
        };
    });

    return { data, error: { subscribe: errorStore.subscribe } };
}

export type { SubscriptionHandle, SubscriptionStoreOptions };
export { subscription };
