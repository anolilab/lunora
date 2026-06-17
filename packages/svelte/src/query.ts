import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionErrorCallback } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { getLunoraClient } from "./context";

/** Narrow an unknown value to a {@link FunctionReference} by its `__lunoraRef` marker. */
const isFunctionReference = (value: unknown): value is FunctionReference =>
    typeof value === "object" && value !== null && typeof (value as { __lunoraRef?: unknown }).__lunoraRef === "string";

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
 * Pass `client` explicitly, or omit it to resolve the ambient client published
 * by `setLunoraClient` (which must therefore be called during component init,
 * before this runs).
 */
export function query<F extends FunctionReference>(function_: F, args: ArgsOf<F>, options?: QueryStoreOptions): QueryStore<F>;
export function query<F extends FunctionReference>(client: LunoraClient, function_: F, args: ArgsOf<F>, options?: QueryStoreOptions): QueryStore<F>;
export function query<F extends FunctionReference>(
    clientOrFunction: LunoraClient | F,
    functionOrArguments: ArgsOf<F> | F,
    argumentsOrOptions?: ArgsOf<F> | QueryStoreOptions,
    maybeOptions?: QueryStoreOptions,
): QueryStore<F> {
    // Resolve the overload: when the first arg is a function reference (carries
    // `__lunoraRef`), the ambient context client is used; otherwise the explicit
    // client was passed first.
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as ArgsOf<F>;
    const options = (hasExplicitClient ? maybeOptions : (argumentsOrOptions as QueryStoreOptions | undefined)) ?? {};

    return readable<ReturnOf<F> | undefined>(undefined, (set) =>
        // The shared `@lunora/client/query` state machine owns the subscribe +
        // cleanup: it replays the last value synchronously when one exists and
        // pushes every subsequent delta into the store, and its returned teardown
        // is the store's stop callback, so the WS subscription closes when the
        // last `$`-reader detaches.
        createQuerySubscription<F>(
            client,
            functionRef,
            args,
            {
                onData: (value: ReturnOf<F>) => {
                    set(value);
                },
                onError: options.onError,
            },
            { shardKey: options.shardKey },
        ),
    );
}
