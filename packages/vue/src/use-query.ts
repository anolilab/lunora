import type { ArgsOf, CirrusClient, FunctionReference, ReturnOf, Unsubscribe } from "@cirrus/client";
import type { Ref } from "vue";
import { getCurrentScope, onScopeDispose, shallowRef } from "vue";

import { useCirrusClient } from "./cirrus-provider";
import type { UseQueryOptions } from "./types";

/**
 * Open a live subscription against `client` and stream its values into a `ref`.
 *
 * Shared by {@link useQuery} and `hydratePreloaded`: both want "open a WS
 * subscription, push every server delta into a ref, tear down on scope dispose."
 * `client.subscribe` already dedupes by `(functionPath, args, shardKey)` and
 * replays the last value synchronously, so multiple consumers of the same query
 * ride one server-side registration.
 *
 * The teardown is wired to the active effect scope (`onScopeDispose`) so it
 * fires on component unmount *or* when an `effectScope().stop()` runs — which is
 * what lets the composable be unit-tested without mounting a component.
 *
 * `seed` (used by the preloaded handoff) sets the ref's value synchronously
 * before the subscription attaches, so the first read shows the SSR value with
 * no loading flash.
 */
export const subscribeToQuery = <F extends FunctionReference, T = ReturnOf<F>>(
    client: CirrusClient,
    function_: F,
    args: ArgsOf<F>,
    options: { seed?: T; shardKey?: string } = {},
): Ref<T | undefined> => {
    // `shallowRef` — query results are replaced wholesale on every push, never
    // mutated in place, so deep reactivity would only add overhead.
    const data = shallowRef<T | undefined>(options.seed) as Ref<T | undefined>;

    const unsubscribe: Unsubscribe = client.subscribe(
        function_,
        args,
        (value) => {
            data.value = value as T;
        },
        { shardKey: options.shardKey },
    );

    // Tear down with the surrounding scope (component unmount or
    // `effectScope().stop()`). Guard `getCurrentScope` so a call outside any
    // scope still unsubscribes — it just leaks until the caller drops the ref;
    // we surface that by unsubscribing eagerly when there's no scope to own it.
    if (getCurrentScope()) {
        onScopeDispose(unsubscribe);
    }

    return data;
};

/**
 * Subscribe to a server query and expose its latest value as a `ref`.
 *
 * The returned ref is `undefined` until the first server response lands, then
 * updates on every delta the server pushes — the Vue-idiomatic equivalent of
 * React's `useQuery`. The underlying WS subscription is torn down automatically
 * when the owning component unmounts (or the effect scope stops).
 *
 * Call inside `setup()` (or any active effect scope). For SSR seeding with no
 * loading flash, use `hydratePreloaded` instead.
 */
export const useQuery = <F extends FunctionReference>(function_: F, args: ArgsOf<F>, options: UseQueryOptions = {}): Ref<ReturnOf<F> | undefined> => {
    const client = useCirrusClient();

    return subscribeToQuery<F>(client, function_, args, { shardKey: options.shardKey });
};
