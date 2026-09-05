import type { FunctionReference, LunoraClient, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { keyHash } from "./query-key";

/**
 * Per-key bookkeeping: a single WS subscription is shared across every hook
 * that observes the same `queryKey`. The `refCount` field tracks the consumers
 * so we close the underlying subscription on the last `detach()`.
 */
interface RegistryEntry {
    /**
     * Per-consumer error sinks. One shared subscription serves every hook on the
     * key, so a server-pushed subscription error fans out to whichever consumers
     * asked for one — read live at fire time, so a consumer that attached after
     * the subscription opened still hears about it.
     */
    errorCallbacks: Set<SubscriptionErrorCallback>;
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
 * single WS subscription. On the last `detach()` the subscription is closed.
 *
 * `client.subscribe` is NOT caught here. A missing WebSocket does not throw —
 * `ensureSocket` returns silently and the subscription simply stays unfed — so
 * the only throws reachable are a closed client and args the wire codec cannot
 * encode. Both are programming errors that no amount of retrying fixes, and the
 * 5s `invalidateQueries` loop that used to swallow them just hid the stack
 * behind a silently-degraded query.
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
     * Whether any consumer still holds the subscription for `queryKey`.
     *
     * Read by {@link file://./use-paginated-core.ts} after its own `detach()`:
     * that hook owns its cache entries' whole lifecycle (it has no TanStack
     * observer, so it pins them against gc and removes them by hand), and it
     * must not remove an entry a sibling hook on the same page range is still
     * being fed through.
     */
    public hasConsumers(queryKey: QueryKey): boolean {
        return this.entries.has(keyHash(queryKey));
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
        options: { onError?: SubscriptionErrorCallback } = {},
    ): () => void {
        const key = keyHash(queryKey);
        let entry = this.entries.get(key);

        if (!entry) {
            entry = { errorCallbacks: new Set(), refCount: 0, unsubscribe: undefined };
            this.entries.set(key, entry);

            const opened = entry;

            try {
                entry.unsubscribe = this.client.subscribe(
                    function_,
                    args,
                    (value) => {
                        queryClient.setQueryData(queryKey, value);
                    },
                    {
                        onError: (error) => {
                            for (const callback of opened.errorCallbacks) {
                                callback(error);
                            }
                        },
                        shardKey,
                    },
                );
            } catch (error) {
                // Leave no half-registered entry behind for the next attach of
                // this key to join, then let the programming error surface.
                this.entries.delete(key);

                throw error;
            }
        }

        entry.refCount += 1;

        const { onError } = options;

        if (onError) {
            entry.errorCallbacks.add(onError);
        }

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

            if (onError) {
                current.errorCallbacks.delete(onError);
            }

            if (current.refCount <= 0) {
                current.unsubscribe?.();
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
