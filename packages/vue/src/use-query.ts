import type { ArgsOf, CirrusClient, FunctionReference, ReturnOf, Unsubscribe } from "@cirrus/client";
import { createQuerySubscription } from "@cirrus/query-core";
import type { MaybeRefOrGetter, Ref } from "vue";
import { getCurrentScope, onScopeDispose, shallowRef, toValue, watch } from "vue";

import { useCirrus } from "./cirrus-provider";
import type { UseQueryOptions } from "./types";

/**
 * Open a live subscription against `client` for FIXED args and stream its values
 * into a `ref`. The low-level primitive behind `hydratePreloaded` (whose args
 * come from an immutable `Preloaded` token and never change); {@link useQuery}
 * handles the reactive-args case separately.
 *
 * `client.subscribe` already dedupes by `(functionPath, args, shardKey)` and
 * replays the last value synchronously, so multiple consumers of the same query
 * ride one server-side registration. `seed` sets the ref's value synchronously
 * before the subscription attaches, so the first read shows the SSR value with
 * no loading flash.
 *
 * Teardown is wired to the active effect scope (`onScopeDispose`), so it fires
 * on component unmount or `effectScope().stop()`. Call it inside `setup()` / an
 * effect scope (as `hydratePreloaded` does); outside any scope there is nothing
 * to own the subscription, so it would leak until the process exits — the
 * `getCurrentScope` guard only avoids throwing, it does not auto-clean.
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
 * React's `useQuery`. `args` may be a plain value, a `ref`, or a getter: passing
 * a reactive source makes the subscription reactive — when the args change the
 * old subscription is torn down and a fresh one opens for the new args (matching
 * `@cirrus/react`/`@cirrus/solid`). Pass `"skip"` (or a source resolving to
 * `"skip"`) to short-circuit: no network call, no socket. The subscription tears
 * down automatically when the owning component unmounts (or the effect scope
 * stops).
 *
 * Call inside `setup()` (or any active effect scope). For SSR seeding with no
 * loading flash, use `hydratePreloaded` instead.
 */
export const useQuery = <F extends FunctionReference>(
    function_: F,
    args: MaybeRefOrGetter<ArgsOf<F> | "skip">,
    options: UseQueryOptions = {},
): Ref<ReturnOf<F> | undefined> => {
    const client = useCirrus();
    const data = shallowRef<ReturnOf<F> | undefined>(undefined) as Ref<ReturnOf<F> | undefined>;

    // Re-subscribe whenever the (reactive) args change: `watch`'s `onCleanup`
    // tears down the previous subscription before opening the next, and also runs
    // when the surrounding effect scope stops (component unmount). A plain-value
    // `args` resolves once and the watcher never re-fires. The skip-handling,
    // subscribe, and cleanup are owned by the shared `@cirrus/query-core` state
    // machine; this composable only binds it to a Vue `ref`.
    watch(
        () => toValue(args),
        (current, _previous, onCleanup) => {
            const unsubscribe = createQuerySubscription(
                client,
                function_,
                current,
                {
                    onData: (value) => {
                        data.value = value;
                    },
                    onReset: () => {
                        data.value = undefined;
                    },
                },
                { shardKey: options.shardKey },
            );

            onCleanup(unsubscribe);
        },
        { immediate: true },
    );

    return data;
};
