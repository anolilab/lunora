import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { keyHash } from "./query-key";

/**
 * Per-key bookkeeping: a single WS subscription is shared across every hook
 * that observes the same `queryKey`. The `refCount` field tracks the consumers
 * so we close the underlying subscription on the last `detach()`.
 */
interface RegistryEntry {
    /** Polling fallback when `client.subscribe` is unavailable (e.g. no WS). */
    pollTimer: ReturnType<typeof setInterval> | undefined;
    refCount: number;
    /** WS unsubscribe handle, set on first successful attach. */
    unsubscribe: Unsubscribe | undefined;
}

/**
 * Per-client subscription dedup layer that sits *next to* TanStack Query.
 *
 * Where the old `QueryCache` owned both the data *and* the subscription
 * lifecycle, this adapter only owns the subscription side: data lives in the
 * TanStack {@link QueryClient}. The flow on every push is
 * `client.subscribe(fn, args, value => qc.setQueryData(queryKey, value))`.
 *
 * Every hook that mounts a `useQuery({queryKey: ["lunora", fn, args, shard]})`
 * also calls `registry.attach(qc, queryKey, fn, args, shardKey)`; the registry
 * dedupes by hashed queryKey so two components observing the same query open a
 * single WS subscription. On the last `detach()` the subscription is closed
 * (or the polling fallback is cleared).
 *
 * Polling fallback: if `client.subscribe` throws (no WS in the environment),
 * the registry installs a 5s interval that calls `qc.invalidateQueries({
 * queryKey })`, letting TanStack's own `refetch` loop drive freshness.
 */
class LunoraSubscriptionRegistry {
    private readonly entries = new Map<string, RegistryEntry>();

    public constructor(private readonly client: LunoraClient) {}

    /**
     * Hash a TanStack `queryKey` to the internal registry index. Exposed so a
     * hook can look up the registry without re-implementing the hash.
     */
    // eslint-disable-next-line class-methods-use-this -- instance method by design: callers reach the hash through a registry handle rather than importing the module-level helper.
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
        function_: FunctionReference,
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
                    function_,
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
                    queryClient.invalidateQueries({ queryKey }).catch(() => {
                        // Best-effort refresh: a failed invalidation just means
                        // the next tick tries again.
                    });
                }, options.pollIntervalMs ?? 5000);
            }
        }

        entry.refCount += 1;

        // Single-shot guard: a second call of THIS detach must be a genuine
        // no-op. Without it, a stale second call re-reads `entries.get(key)` and
        // would decrement whatever entry now lives under the hash — possibly a
        // DIFFERENT consumer's fresh entry (same key re-attached after this one
        // fully detached) — closing a live subscription that is still in use.
        let detached = false;

        return () => {
            if (detached) {
                return;
            }

            detached = true;

            // `entries.get(key)` is read again because a sibling detach may have
            // already torn the entry down.
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

const registryByClient = new WeakMap<LunoraClient, LunoraSubscriptionRegistry>();

/** Returns the shared subscription registry for `client`, creating it on first access. */
const getSubscriptionRegistry = (client: LunoraClient): LunoraSubscriptionRegistry => {
    let registry = registryByClient.get(client);

    if (!registry) {
        registry = new LunoraSubscriptionRegistry(client);
        registryByClient.set(client, registry);
    }

    return registry;
};

export { getSubscriptionRegistry, LunoraSubscriptionRegistry };
export { lunoraQueryKey, serializeQueryKey, stableStringify, stableWireKey } from "./query-key";
