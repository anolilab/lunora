import type { CirrusClient, FunctionReference, Unsubscribe } from "@cirrus/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Per-key bookkeeping: a single WS subscription is shared across every hook
 * that observes the same `queryKey`. {@link refCount} tracks the consumers so
 * we close the underlying subscription on the last `detach()`.
 */
interface RegistryEntry {
    /** Polling fallback when `client.subscribe` is unavailable (e.g. no WS). */
    pollTimer: ReturnType<typeof setInterval> | undefined;
    refCount: number;
    /** WS unsubscribe handle, set on first successful attach. */
    unsubscribe: Unsubscribe | undefined;
}

/** Stringified queryKey used as the internal index key for {@link CirrusSubscriptionRegistry}. */
const keyHash = (queryKey: QueryKey): string => JSON.stringify(queryKey);

/**
 * Per-client subscription dedup layer that sits *next to* TanStack Query.
 *
 * Where the old `QueryCache` owned both the data *and* the subscription
 * lifecycle, this adapter only owns the subscription side: data lives in the
 * TanStack {@link QueryClient}. The flow on every push:
 *
 *   client.subscribe(fn, args, value => qc.setQueryData(queryKey, value))
 *
 * Every hook that mounts a `useQuery({queryKey: ["cirrus", fn, args, shard]})`
 * also calls `registry.attach(qc, queryKey, fn, args, shardKey)`; the registry
 * dedupes by hashed queryKey so two components observing the same query open a
 * single WS subscription. On the last `detach()` the subscription is closed
 * (or the polling fallback is cleared).
 *
 * Polling fallback: if `client.subscribe` throws (no WS in the environment),
 * the registry installs a 5s interval that calls `qc.invalidateQueries({
 * queryKey })`, letting TanStack's own `refetch` loop drive freshness.
 */
export class CirrusSubscriptionRegistry {
    private readonly entries = new Map<string, RegistryEntry>();

    public constructor(private readonly client: CirrusClient) {}

    /**
     * Hash a TanStack `queryKey` to the internal registry index. Exposed so a
     * hook can look up the registry without re-implementing the hash.
     */
    public keyOf(queryKey: QueryKey): string {
        return keyHash(queryKey);
    }

    /**
     * Attach a consumer to the live subscription for `queryKey`. The first
     * attach opens the underlying WS subscription; subsequent attaches reuse
     * it (refcount-bumped). Returns the detach function — call it exactly once
     * per attach.
     */
    public attach(
        queryClient: QueryClient,
        queryKey: QueryKey,
        fn: FunctionReference,
        args: Record<string, unknown>,
        shardKey: string | undefined,
        options: { pollIntervalMs?: number } = {},
    ): () => void {
        const key = keyHash(queryKey);
        let entry = this.entries.get(key);

        if (!entry) {
            entry = { pollTimer: undefined, refCount: 0, unsubscribe: undefined };
            this.entries.set(key, entry);

            try {
                entry.unsubscribe = this.client.subscribe(
                    fn,
                    args,
                    (value) => {
                        queryClient.setQueryData(queryKey, value);
                    },
                    { shardKey },
                );
            } catch {
                // WS unavailable — fall back to periodic invalidation so
                // TanStack Query's own refetch loop keeps the cache fresh.
                entry.pollTimer = setInterval(() => {
                    void queryClient.invalidateQueries({ queryKey });
                }, options.pollIntervalMs ?? 5000);
            }
        }

        entry.refCount += 1;

        return () => {
            // `entries.get(key)` is read again because a sibling detach may have
            // already torn the entry down. Calling detach twice is a no-op.
            const current = this.entries.get(key);

            if (!current) {
                return;
            }

            current.refCount -= 1;

            if (current.refCount <= 0) {
                current.unsubscribe?.();

                if (current.pollTimer) {
                    clearInterval(current.pollTimer);
                }

                this.entries.delete(key);
            }
        };
    }
}

/**
 * Project a Cirrus `(fn, args, shardKey)` triple into the structural query key
 * TanStack hashes for dedup. The `"cirrus"` literal namespaces our entries so
 * an app's own queries can't collide with ours.
 */
export const cirrusQueryKey = (fn: FunctionReference, args: Record<string, unknown>, shardKey: string | undefined): QueryKey => {
    return ["cirrus", fn.__cirrusRef, args, shardKey ?? null];
};

/**
 * Stringify a queryKey for use in a React effect's dep list. TanStack hashes
 * queryKeys structurally, so the dep list mirrors that — two args objects with
 * the same contents but different identity hash to the same string and won't
 * trigger a re-attach.
 */
export const serializeQueryKey = (queryKey: QueryKey): string => keyHash(queryKey);

const registryByClient = new WeakMap<CirrusClient, CirrusSubscriptionRegistry>();

/** Returns the shared subscription registry for `client`, creating it on first access. */
export const getSubscriptionRegistry = (client: CirrusClient): CirrusSubscriptionRegistry => {
    let registry = registryByClient.get(client);

    if (!registry) {
        registry = new CirrusSubscriptionRegistry(client);
        registryByClient.set(client, registry);
    }

    return registry;
};
