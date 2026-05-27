import type { ArgsOf, FunctionReference, ReturnOf } from "@cirrus/client";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { getCache } from "./cache.js";
import { useCirrus } from "./CirrusProvider.js";
import type { UseQueryOptions } from "./types.js";

/**
 * Subscribe to a server query.
 *
 * Returns `undefined` until the first response lands. Pass `"skip"` for
 * `args` to short-circuit the query (no network call, no cache entry).
 *
 * Multiple components calling `useQuery` with the same arguments share a
 * single underlying network call thanks to the shared cache in `cache.ts`.
 */
export function useQuery<F extends FunctionReference>(
    fn: F,
    args: ArgsOf<F> | "skip",
    options: UseQueryOptions = {},
): ReturnOf<F> | undefined {
    const client = useCirrus();
    const cache = getCache(client);

    const skipped = args === "skip";
    const argsRecord = (skipped ? {} : (args as Record<string, unknown>)) ?? {};
    const shardKey = options.shardKey;
    const key = cache.keyOf(fn, argsRecord, shardKey);

    const releaseRef = useRef<(() => void) | null>(null);
    const lastKeyRef = useRef<string | null>(null);

    // Maintain a stable subscribe handle so useSyncExternalStore doesn't churn.
    const listenersRef = useRef(new Set<() => void>());

    const subscribe = useRef((cb: () => void) => {
        listenersRef.current.add(cb);

        return () => {
            listenersRef.current.delete(cb);
        };
    }).current;

    const notify = (): void => {
        for (const listener of listenersRef.current) {
            listener();
        }
    };

    useEffect(() => {
        if (skipped) {
            return;
        }

        const handle = cache.acquire(fn, argsRecord, shardKey, notify);

        releaseRef.current = handle.release;
        lastKeyRef.current = key;

        // Trigger an immediate notify in case data already exists.
        notify();

        return () => {
            handle.release();
            releaseRef.current = null;
            lastKeyRef.current = null;
        };
    }, [key, skipped]);

    const getSnapshot = (): ReturnOf<F> | undefined => {
        if (skipped) {
            return undefined;
        }

        const entry = cache.peek(key);

        return entry?.data as ReturnOf<F> | undefined;
    };

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
