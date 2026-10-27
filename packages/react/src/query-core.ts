"use client";

import type { FunctionReference, LunoraClient, SubscriptionErrorCallback } from "@lunora/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { getSubscriptionRegistry } from "./cache";

interface QuerySubscriptionInput {
    args: Record<string, unknown>;
    /** `stableWireKey(args)`, which the caller has already computed for the query key. */
    argsKey: string;
    client: LunoraClient;
    function_: FunctionReference;
    onError: SubscriptionErrorCallback | undefined;
    queryClient: QueryClient;
    queryKey: QueryKey;
    shardKey: string | undefined;
    skipped: boolean;
}

/**
 * Attach the shared WS subscription that pushes into a query's TanStack cache
 * entry, for as long as the calling component is mounted.
 *
 * The registry keys its attach on the serialized query key, so an inline
 * `onError` changing identity must not re-run the effect: a stable wrapper is
 * registered once and the latest handler is read through a ref.
 */
const useQuerySubscription = ({ args, argsKey, client, function_, onError, queryClient, queryKey, shardKey, skipped }: QuerySubscriptionInput): void => {
    // Content hash of the query identity: the effect re-attaches when it changes, not on a fresh
    // `function_`/`args` object. `\u0001` marks an absent shardKey so it stays distinct from `""`, as in the queryKey.
    const subscriptionKey = `${function_.__lunoraRef}\u0000${argsKey}\u0000${shardKey ?? "\u0001"}`;

    const onErrorRef = useRef(onError);

    useEffect(() => {
        onErrorRef.current = onError;
    });

    const stableOnError = useCallback<SubscriptionErrorCallback>(
        (error) => {
            onErrorRef.current?.(error);
        },
        [onErrorRef],
    );

    useEffect(() => {
        if (skipped) {
            return () => {};
        }

        return getSubscriptionRegistry(client).attach(queryClient, queryKey, function_, args, shardKey, { onError: stableOnError });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the WS subscription re-attaches only when the serialized query key (a stable content hash), the client, or the skip flag changes — not on every fresh `function_`/`args`/`shardKey` object identity. `stableOnError` is ref-backed and never changes. `client` is a dependency, so a provider `client` swap re-attaches to the new client.
    }, [client, queryClient, subscriptionKey, skipped, stableOnError]);
};

export default useQuerySubscription;
