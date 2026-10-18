"use client";

import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionErrorCallback } from "@lunora/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { getSubscriptionRegistry } from "./cache";

interface QuerySubscriptionInput {
    args: Record<string, unknown>;
    client: LunoraClient;
    function_: FunctionReference;
    onError: SubscriptionErrorCallback | undefined;
    queryClient: QueryClient;
    queryKey: QueryKey;
    shardKey: string | undefined;
    skipped: boolean;
    /** Content hash of the query identity: the effect re-attaches when it changes, not on a fresh `function_`/`args` object. */
    subscriptionKey: string;
}

/**
 * Attach the shared WS subscription that pushes into a query's TanStack cache
 * entry, for as long as the calling component is mounted.
 *
 * The registry keys its attach on the serialized query key, so an inline
 * `onError` changing identity must not re-run the effect: a stable wrapper is
 * registered once and the latest handler is read through a ref.
 */
const useQuerySubscription = ({
    args,
    client,
    function_,
    onError,
    queryClient,
    queryKey,
    shardKey,
    skipped,
    subscriptionKey,
}: QuerySubscriptionInput): void => {
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

/**
 * The one-shot HTTP snapshot behind a query's first value.
 *
 * It races the subscription that feeds the same key. TanStack applies a resolved
 * `queryFn` result unconditionally — a `setQueryData` while the fetch is in
 * flight does NOT cancel it — so a push that lands first would be reverted to
 * pre-push data, and with `staleTime: Infinity` and push-driven freshness it
 * stays reverted until the next write (and bypasses the optimistic layer engine,
 * since the TanStack cache was written raw). Sample the key's push counter either
 * side of the fetch and yield to anything newer.
 */
const fetchQuerySnapshot = async <F extends FunctionReference>(
    client: LunoraClient,
    queryClient: QueryClient,
    function_: F,
    args: Record<string, unknown>,
    shardKey: string | undefined,
    queryKey: QueryKey,
): Promise<ReturnOf<F>> => {
    const registry = getSubscriptionRegistry(client);
    const sample = registry.openSnapshotSample(queryKey);
    const snapshot = await client.query<F>(function_, args as ArgsOf<F>, { shardKey });

    if (registry.closeSnapshotSample(sample)) {
        return snapshot;
    }

    return queryClient.getQueryData<ReturnOf<F>>(queryKey) ?? snapshot;
};

export { fetchQuerySnapshot, useQuerySubscription };
