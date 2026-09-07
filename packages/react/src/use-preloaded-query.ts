"use client";

import type { FunctionReference, Preloaded, SubscriptionErrorCallback } from "@lunora/client";
import { useQuery as useTanStackQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { getSubscriptionRegistry, lunoraQueryKey, serializeQueryKey } from "./cache";
import { useLunora } from "./lunora-provider";

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live.
 *
 * The first render returns the preloaded value (TanStack's `initialData`),
 * so the server markup and the initial client markup match — no hydration
 * mismatch, no loading flash. After mount, a WS subscription attaches so
 * later server pushes update the value just like `useQuery`.
 *
 * The {@link Preloaded} token's `value` seeds `initialData`; we don't need a
 * full dehydrate/hydrate dance because the consumer hands us the resolved
 * value directly. Apps that want to share a pre-populated QueryClient across
 * many preloaded queries can pass their own `queryClient` to `LunoraProvider`
 * and hydrate it themselves via TanStack's `hydrate(qc, dehydratedState)`.
 *
 * Pass `onError` to surface a subscription-scoped error the server pushes (a
 * session expiry, an RLS denial). Without it such an error is dropped and the
 * hook keeps rendering the SSR snapshot as if it were live.
 */
const usePreloadedQuery = function <T>(preloaded: Preloaded<T>, options: { onError?: SubscriptionErrorCallback } = {}): T {
    const client = useLunora();
    const queryClient = useQueryClient();

    // The attach effect keys on the serialized query key, so an inline `onError`
    // must not change its identity — register a stable wrapper and read the
    // latest handler through a ref (the same shape `useQuery` uses).
    const onErrorRef = useRef(options.onError);

    useEffect(() => {
        onErrorRef.current = options.onError;
    });

    const stableOnError = useCallback<SubscriptionErrorCallback>((error) => {
        onErrorRef.current?.(error);
    }, []);

    const { args, functionPath, shardKey, value } = preloaded;
    // Both values are consumed structurally (TanStack hashes `queryKey`; the
    // effect keys off `serializeQueryKey(queryKey)`, a content hash), so a fresh
    // reference each render is fine — React Compiler auto-memoizes these
    // derivations, so no manual `useMemo` is needed.
    const functionRef: FunctionReference = { __lunoraRef: functionPath };
    const queryKey = lunoraQueryKey(functionRef, args, shardKey);

    // Client is provider-stable (it comes from LunoraContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache.
    const { data } = useTanStackQuery<T>({
        // Seed the cache with the server value so the first paint doesn't
        // re-fetch. TanStack treats `initialData` as fresh — the WS push from
        // the registry is what supplies subsequent updates.
        initialData: value,
        queryFn: () => client.query(functionRef, args, { shardKey }) as Promise<T>,
        queryKey,
        staleTime: Number.POSITIVE_INFINITY,
    });

    useEffect(() => {
        const registry = getSubscriptionRegistry(client);

        return registry.attach(queryClient, queryKey, functionRef, args, shardKey, { onError: stableOnError });
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the WS subscription re-attaches only when the serialized query key (a stable content hash) or the client changes — not on every fresh `functionRef`/`args`/`shardKey` identity. `stableOnError` is ref-backed and never changes. `client` is provider-stable (swapping it remounts the provider subtree).
    }, [client, queryClient, serializeQueryKey(queryKey), stableOnError]);

    // TanStack types `data` as `T | undefined` even with `initialData` because
    // the option could be a falsy value. We always pass the preloaded `value`,
    // so the only way `data` is genuinely absent from the cache is the consumer
    // preloading an explicit `undefined` — fall back to `value` in exactly that
    // case. A `??` here would also coalesce `null`, but `null` is a normal
    // Lunora query result (document deleted, access revoked): a live push of
    // `null` must pass through, not resurrect the stale preloaded value.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: a live null push must pass through, not fall back to the stale preloaded value
    return data === undefined ? value : data;
};

/**
 * The PLAN4 §1 framework-neutral name for the preloaded-hydration handoff:
 * `hydratePreloaded(preloaded)` seeds the SSR value on the first paint, then
 * attaches a live WS subscription on mount. It is a thin alias of
 * {@link usePreloadedQuery} so the React adapter exposes the same
 * `hydratePreloaded` primitive every other adapter (Solid, Svelte, Vue) will,
 * while existing callers of `usePreloadedQuery` keep working unchanged.
 *
 * It carries React's Rules-of-Hooks contract (it calls hooks internally), so
 * call it like a hook — at the top level of a component, unconditionally.
 */
const hydratePreloaded = function <T>(preloaded: Preloaded<T>, options: { onError?: SubscriptionErrorCallback } = {}): T {
    // react-doctor-disable-next-line react-doctor/rules-of-hooks -- `hydratePreloaded` is a deliberate hook alias (documented above): it carries React's Rules-of-Hooks contract and must be called like a hook. The lowercase name is the framework-neutral public primitive every adapter exposes; renaming it to `use*` would break the cross-adapter API.
    return usePreloadedQuery(preloaded, options);
};

export { hydratePreloaded };
export default usePreloadedQuery;
