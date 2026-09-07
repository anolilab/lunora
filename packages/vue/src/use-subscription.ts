import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/client";
import { createQuerySubscription } from "@lunora/client/query";
import { LunoraError } from "@lunora/errors";
import type { MaybeRefOrGetter, Ref } from "vue";
import { onScopeDispose, ref, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";
import type { UseQueryOptions } from "./types";

interface UseSubscriptionResult<T> {
    data: Ref<T | undefined>;
    error: Ref<Error | undefined>;
}

/**
 * Subscribe to a reactive server push stream. Returns `{ data, error }` refs
 * that update whenever the server emits a new value. Passing `"skip"` as `args`
 * (or a ref/getter that resolves to `"skip"`) tears down the subscription
 * without unmounting.
 *
 * Unlike `useQuery`, which tracks the full reactive cache, `useSubscription`
 * owns a single lightweight subscription and is suitable for ephemeral,
 * high-frequency streams.
 */
const useSubscription = <F extends FunctionReference>(
    function_: F,
    args: MaybeRefOrGetter<ArgsOf<F> | "skip">,
    options: UseQueryOptions = {},
): UseSubscriptionResult<ReturnOf<F>> => {
    const client = useLunora();
    const data = ref<ReturnOf<F> | undefined>(undefined) as Ref<ReturnOf<F> | undefined>;
    const error = ref<Error | undefined>(undefined);

    watch(
        () => toValue(args),
        (currentArgs, _previous, onCleanup) => {
            // Each args generation starts clean: the previous args' value must not
            // render under the new args until the new subscription's first frame.
            data.value = undefined;
            error.value = undefined;

            if (currentArgs === "skip") {
                return;
            }

            // Client-only: an `immediate: true` watcher fires once during
            // `renderToString` with no unmount to run `onCleanup` (see
            // `use-presence.ts`'s guard rationale) — skip the subscription
            // server-side and leave `data`/`error` at their inert initial values.
            if (!isBrowser()) {
                return;
            }

            const unsubscribe = createQuerySubscription(
                client,
                function_,
                currentArgs,
                {
                    onData: (value: ReturnOf<F>) => {
                        data.value = value;
                        error.value = undefined;
                    },
                    onError: (subscriptionError) => {
                        // Preserve the server-supplied `code` so consumers of the
                        // `error` ref can branch on the error kind (UNAUTHORIZED
                        // vs NOT_FOUND, …) instead of only seeing a flat message.
                        error.value =
                            subscriptionError.code === undefined
                                ? new Error(subscriptionError.message)
                                : new LunoraError(subscriptionError.code, subscriptionError.message);
                        data.value = undefined;
                        // `UseQueryOptions.onError` is part of this composable's
                        // surface; forward the raw wire error (code included) so a
                        // caller that only passes a handler still sees the failure.
                        options.onError?.(subscriptionError);
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

    onScopeDispose(() => {
        data.value = undefined;
        error.value = undefined;
    });

    return { data, error };
};

export type { UseSubscriptionResult };
export { useSubscription };
