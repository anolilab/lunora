import type { FunctionReference, Preloaded } from "@cirrus/client";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getCache } from "./cache.js";
import { useCirrus } from "./cirrus-provider.js";

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live.
 *
 * The first render — on the server and on the client before effects run —
 * returns the preloaded value, so the server markup and the initial client
 * markup match (no hydration mismatch, no loading flash). Once mounted, the
 * hook seeds the shared query cache with that value (skipping the redundant
 * initial fetch) and attaches a WS subscription, so later server pushes update
 * the value just like {@link useQuery}.
 */
export function usePreloadedQuery<T>(preloaded: Preloaded<T>): T {
    const client = useCirrus();
    const cache = getCache(client);

    const { args, functionPath, shardKey, value } = preloaded;
    const fn = useMemo<FunctionReference>(() => ({ __cirrusRef: functionPath }), [functionPath]);
    const key = cache.keyOf(fn, args, shardKey);

    // Stable subscribe handle so useSyncExternalStore doesn't churn (mirrors useQuery).
    const listenersRef = useRef(new Set<() => void>());
    const subscribe = useRef((cb: () => void) => {
        listenersRef.current.add(cb);

        return () => {
            listenersRef.current.delete(cb);
        };
    }).current;

    const acquireRef = useRef({ args, fn, shardKey, value });

    acquireRef.current = { args, fn, shardKey, value };

    useEffect(() => {
        const notify = (): void => {
            for (const listener of listenersRef.current) {
                listener();
            }
        };

        const { args: currentArgs, fn: currentFn, shardKey: currentShardKey, value: currentValue } = acquireRef.current;
        const handle = cache.acquire(currentFn, currentArgs, currentShardKey, notify, { initialData: { value: currentValue } });

        notify();

        return () => {
            handle.release();
        };
    }, [cache, key]);

    const getSnapshot = (): T => {
        const entry = cache.peek(key);

        // Fall back to the preloaded value until live data lands — covers both
        // the pre-effect first render and an entry another hook left "loading".
        return (entry?.data ?? value) as T;
    };

    const getServerSnapshot = (): T => value;

    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
