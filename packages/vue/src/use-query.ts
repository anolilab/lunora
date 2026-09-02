import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import type { MaybeRefOrGetter, Ref } from "vue";
import { shallowRef, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";
import onScopeDisposeOrWarn from "./scope-dispose";
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
 * no loading flash. `onError` receives a subscription-scoped error the server
 * pushes (a session expiry, an RLS denial); without it the ref keeps rendering
 * the seed as if it were live.
 *
 * Teardown is wired to the active effect scope (`onScopeDispose`), so it fires
 * on component unmount or `effectScope().stop()`. Call it inside `setup()` / an
 * effect scope (as `hydratePreloaded` does); outside any scope there is nothing
 * to own the subscription, so it would leak until the process exits — the
 * `getCurrentScope` guard only avoids throwing, it does not auto-clean.
 */
export const subscribeToQuery = <F extends FunctionReference, T = ReturnOf<F>>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F>,
    options: { onError?: SubscriptionErrorCallback; seed?: T; shardKey?: string } = {},
): Ref<T | undefined> => {
    // `shallowRef` — query results are replaced wholesale on every push, never
    // mutated in place, so deep reactivity would only add overhead.
    const data = shallowRef<T | undefined>(options.seed) as Ref<T | undefined>;

    // Client-only: called during SSR this would open a live subscription that
    // never tears down (see `use-presence.ts`'s guard rationale). The seed
    // above already gives SSR HTML its value; skip the subscription server-side.
    if (isBrowser()) {
        const unsubscribe: Unsubscribe = client.subscribe(
            function_,
            args,
            (value) => {
                data.value = value as T;
            },
            { onError: options.onError, shardKey: options.shardKey },
        );

        onScopeDisposeOrWarn(
            unsubscribe,
            "[@lunora/vue] subscribeToQuery called with no active effect scope — its subscription will not be cleaned up automatically. " +
                "Call it inside setup()/an effect scope, or call the returned teardown yourself.",
        );
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
 * old subscription is torn down, the ref resets to `undefined`, and a fresh one
 * opens for the new args (matching `@lunora/react`/`@lunora/solid`). Pass `"skip"` (or a source resolving to
 * `"skip"`) to short-circuit: no network call, no socket. The subscription tears
 * down automatically when the owning component unmounts (or the effect scope
 * stops).
 *
 * Call inside `setup()` (or any active effect scope). For SSR seeding with no
 * loading flash, use `hydratePreloaded` instead.
 *
 * Pass `onError` to surface a subscription-scoped error the server pushes (an RLS
 * denial, a query that starts failing server-side). Without it such an error is
 * dropped and the ref just freezes at its last good value.
 */
export const useQuery = <F extends FunctionReference>(
    function_: F,
    args: MaybeRefOrGetter<ArgsOf<F> | "skip">,
    options: UseQueryOptions = {},
): Ref<ReturnOf<F> | undefined> => {
    const client = useLunora();
    const data = shallowRef<ReturnOf<F> | undefined>(undefined) as Ref<ReturnOf<F> | undefined>;

    // Re-subscribe whenever the (reactive) args change: `watch`'s `onCleanup`
    // tears down the previous subscription before opening the next, and also runs
    // when the surrounding effect scope stops (component unmount). A plain-value
    // `args` resolves once and the watcher never re-fires. The skip-handling,
    // subscribe, and cleanup are owned by the shared `@lunora/client/query` state
    // machine; this composable only binds it to a Vue `ref`.
    watch(
        () => toValue(args),
        (current, _previous, onCleanup) => {
            // Client-only: an `immediate: true` watcher fires once during
            // `renderToString` with no unmount to run `onCleanup` (see
            // `use-presence.ts`'s guard rationale) — skip the subscription
            // server-side and leave `data` at its inert initial value.
            if (!isBrowser()) {
                return;
            }

            // The previous args' value must not render under the new args until
            // the new subscription's first frame lands.
            data.value = undefined;

            const unsubscribe = createQuerySubscription(
                client,
                function_,
                current,
                {
                    onData: (value) => {
                        data.value = value;
                    },
                    onError: options.onError,
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
