import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";
import { subscribeReactiveArgs } from "./subscribe-reactive-args";

/** Query args, the skip sentinel, or a reactive (`Readable`) source of either. */
export type ReactiveArgs<F extends FunctionReference> = ArgsOf<F> | "skip" | Readable<ArgsOf<F> | "skip">;

/** Options accepted by {@link query}. */
export interface QueryStoreOptions {
    /** Called when the underlying subscription reports an error. */
    onError?: SubscriptionErrorCallback;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * The shape held by a {@link query} store: the latest server value (`undefined`
 * until the first response lands, mirroring React's `useQuery`).
 */
export type QueryStore<F extends FunctionReference> = Readable<ReturnOf<F> | undefined>;

/**
 * Open a live query as a Svelte readable store. Read it with the `$store`
 * idiom in a component (`{$messages}`) and it stays current: a WS subscription
 * attaches the moment the store gains its first subscriber and the value
 * re-emits on every server delta — the Svelte equivalent of React's `useQuery`.
 *
 * The subscription is opened lazily (inside `readable`'s start callback, on the
 * first `$`-read / `.subscribe()`) and torn down by the returned stop function
 * when the last subscriber goes away — so a store that's never read opens no
 * socket, and a component that unmounts releases its subscription. Sharing one
 * store across several components shares a single underlying subscription
 * (the `LunoraClient` de-dupes by `(fn, args, shardKey)`).
 *
 * Pass `"skip"` as `args` to keep the store connected but the subscription
 * dormant (the value stays `undefined`, no socket opens) — useful for a query
 * gated on auth or a route param, matching React/Vue/Solid's `useQuery`.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient` (which must therefore be called during component init,
 * before this runs).
 *
 * `args` may also be a `Readable` store (wrap runes state with `toStore` or
 * `derived`): each emission tears down the previous subscription, resets the
 * value to `undefined`, and opens a fresh one against the new args — the Svelte
 * counterpart of Vue's `MaybeRefOrGetter` args. An emission of `"skip"` tears down without
 * re-opening and resets the value to `undefined`.
 */
export function query<F extends FunctionReference>(function_: F, args: ReactiveArgs<F>, options?: QueryStoreOptions): QueryStore<F>;
export function query<F extends FunctionReference>(client: LunoraClient, function_: F, args: ReactiveArgs<F>, options?: QueryStoreOptions): QueryStore<F>;
export function query<F extends FunctionReference>(
    clientOrFunction: LunoraClient | F,
    functionOrArguments: F | ReactiveArgs<F>,
    argumentsOrOptions?: QueryStoreOptions | ReactiveArgs<F>,
    maybeOptions?: QueryStoreOptions,
): QueryStore<F> {
    // Resolve the overload: when the first arg is a function reference (carries
    // `__lunoraRef`), the ambient context client is used; otherwise the explicit
    // client was passed first.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as ReactiveArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : (argumentsOrOptions as QueryStoreOptions | undefined)) ?? {};

    return readable<ReturnOf<F> | undefined>(undefined, (set) => {
        // The shared `@lunora/client/query` state machine owns the subscribe +
        // cleanup: it replays the last value synchronously when one exists and
        // pushes every subsequent delta into the store, and its returned teardown
        // is the store's stop callback, so the WS subscription closes when the
        // last `$`-reader detaches.
        const open = (resolved: ArgsOf<F> | "skip"): Unsubscribe => {
            // The previous args' value must not render under the new args until
            // the new subscription's first frame lands.
            set(undefined);

            return createQuerySubscription<F>(
                client,
                functionRef,
                resolved,
                {
                    onData: (value: ReturnOf<F>) => {
                        set(value);
                    },
                    onError: options.onError,
                    // `args === "skip"` short-circuits inside the shared helper and
                    // fires this reset — clear any prior value so a store that flips
                    // to `"skip"` does not retain stale data.
                    onReset: () => {
                        set(undefined);
                    },
                },
                { shardKey: options.shardKey },
            );
        };

        return subscribeReactiveArgs<ArgsOf<F> | "skip">(args, open);
    });
}
