import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import type { Readable } from "svelte/store";
import { readable, writable } from "svelte/store";

import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";

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
 * captures the last subscription error. Both stores are lazy: the subscription
 * opens on the first subscriber to `data` and tears down when it stops.
 *
 * Passing `"skip"` as `args` keeps the stores connected but the subscription
 * dormant (`data` stays `undefined`). Pass an explicit `client` as the first
 * argument to bypass the ambient context (useful in tests).
 */
function subscription<F extends FunctionReference>(function_: F, args: ArgsOf<F> | "skip", options?: SubscriptionStoreOptions): SubscriptionHandle<ReturnOf<F>>;
function subscription<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F> | "skip",
    options?: SubscriptionStoreOptions,
): SubscriptionHandle<ReturnOf<F>>;
function subscription<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArgs: F | ArgsOf<F> | "skip",
    argsOrOptions?: ArgsOf<F> | SubscriptionStoreOptions | "skip",
    maybeOptions?: SubscriptionStoreOptions,
): SubscriptionHandle<ReturnOf<F>> {
    // Resolve overloads: when the second argument is a FunctionReference, the
    // first must be an explicit LunoraClient; otherwise use the ambient context.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArgs : clientOrFunction) as F;
    const args = (hasExplicitClient ? argsOrOptions : functionOrArgs) as ArgsOf<F> | "skip";
    const options = (hasExplicitClient ? maybeOptions : (argsOrOptions as SubscriptionStoreOptions | undefined)) ?? {};

    const { shardKey, onError } = options;

    // A writable error store that the data store's start/stop callback pushes into.
    const errorStore = writable<Error | undefined>();

    const data = readable<ReturnOf<F> | undefined>(undefined, (set) => {
        if (args === "skip") {
            return () => undefined;
        }

        const unsubscribe = createQuerySubscription(
            client,
            functionRef,
            args,
            {
                onData: (value: ReturnOf<F>) => {
                    set(value);
                    errorStore.set(undefined);
                },
                onError: (subscriptionError) => {
                    const error = new Error(subscriptionError.message);
                    errorStore.set(error);
                    onError?.(error);
                },
                onReset: () => {
                    set(undefined);
                },
            },
            { shardKey },
        );

        return () => {
            unsubscribe();
            errorStore.set(undefined);
        };
    });

    return { data, error: { subscribe: errorStore.subscribe } };
}

export type { SubscriptionHandle, SubscriptionStoreOptions };
export { subscription };
