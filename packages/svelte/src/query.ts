import type { ArgsOf, CirrusClient, FunctionReference, ReturnOf, SubscriptionErrorCallback } from "@cirrus/client";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { getCirrusClient } from "./context";

/** Narrow an unknown value to a {@link FunctionReference} by its `__cirrusRef` marker. */
const isFunctionReference = (value: unknown): value is FunctionReference =>
    typeof value === "object" && value !== null && typeof (value as { __cirrusRef?: unknown }).__cirrusRef === "string";

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
 * (the `CirrusClient` de-dupes by `(fn, args, shardKey)`).
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setCirrusClient` (which must therefore be called during component init,
 * before this runs).
 */
export function query<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options?: QueryStoreOptions): QueryStore<F>;
export function query<F extends FunctionReference>(client: CirrusClient, function_: F, args: ArgsOf<F>, options?: QueryStoreOptions): QueryStore<F>;
export function query<F extends FunctionReference>(
    clientOrFunction: CirrusClient | F,
    functionOrArguments: ArgsOf<F> | F,
    argumentsOrOptions?: ArgsOf<F> | QueryStoreOptions,
    maybeOptions?: QueryStoreOptions,
): QueryStore<F> {
    // Resolve the overload: when the first arg is a function reference (carries
    // `__cirrusRef`), the ambient context client is used; otherwise the explicit
    // client was passed first.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getCirrusClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as ArgsOf<F>;
    const options = (hasExplicitClient ? maybeOptions : (argumentsOrOptions as QueryStoreOptions | undefined)) ?? {};

    return readable<ReturnOf<F> | undefined>(undefined, (set) =>
        // `subscribe` replays the last value synchronously when one exists and
        // pushes every subsequent delta; the returned unsubscribe is the store's
        // stop callback, so the WS subscription closes when the last `$`-reader
        // detaches.
        client.subscribe<F>(
            functionRef,
            args,
            (value: ReturnOf<F>) => {
                set(value);
            },
            { onError: options.onError, shardKey: options.shardKey },
        ),
    );
}
