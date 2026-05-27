import type { CirrusClient, FunctionReference, Unsubscribe } from "@cirrus/client";

export type CacheStatus = "idle" | "loading" | "ready" | "error";

interface CacheEntry {
    /** Number of active consumers (useQuery / useSubscription mounts). */
    refCount: number;
    status: CacheStatus;
    data: unknown;
    error: Error | undefined;
    /** Subscriber callbacks to notify when this entry changes. */
    listeners: Set<() => void>;
    /** WS unsubscribe for the active subscription, if one is open. */
    unsubscribe: Unsubscribe | undefined;
    /** Polling timer when WS fallback is in effect. */
    pollTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Shared, per-client query cache. Multiple components calling `useQuery` with
 * the same `(functionPath, args, shardKey)` share a single subscription and
 * a single snapshot, so re-renders are coordinated through one listener set.
 */
export class QueryCache {
    private readonly entries = new Map<string, CacheEntry>();

    public constructor(private readonly client: CirrusClient) {}

    public keyOf(fn: FunctionReference, args: unknown, shardKey: string | undefined): string {
        return `${fn.__cirrusRef}::${JSON.stringify(args ?? {})}::${shardKey ?? ""}`;
    }

    public peek(key: string): CacheEntry | undefined {
        return this.entries.get(key);
    }

    /**
     * Acquire (or reuse) a cache entry for the given query. Increments the
     * refcount; callers must invoke the returned `release()` exactly once.
     */
    public acquire(
        fn: FunctionReference,
        args: Record<string, unknown>,
        shardKey: string | undefined,
        listener: () => void,
        options: { pollIntervalMs?: number } = {},
    ): { entry: CacheEntry; key: string; release: () => void } {
        const key = this.keyOf(fn, args, shardKey);
        let entry = this.entries.get(key);

        if (!entry) {
            entry = {
                refCount: 0,
                status: "loading",
                data: undefined,
                error: undefined,
                listeners: new Set(),
                unsubscribe: undefined,
                pollTimer: undefined,
            };
            this.entries.set(key, entry);
            this.beginFetch(entry, fn, args, shardKey, options.pollIntervalMs ?? 5000);
        }

        entry.refCount += 1;
        entry.listeners.add(listener);

        return {
            entry,
            key,
            release: () => {
                if (!entry) {
                    return;
                }

                entry.listeners.delete(listener);
                entry.refCount -= 1;

                if (entry.refCount <= 0) {
                    entry.unsubscribe?.();

                    if (entry.pollTimer) {
                        clearInterval(entry.pollTimer);
                    }

                    this.entries.delete(key);
                }
            },
        };
    }

    /** Notify all listeners of a given entry that something changed. */
    public emit(entry: CacheEntry): void {
        for (const listener of entry.listeners) {
            try {
                listener();
            } catch {
                /* listener threw — ignore so other consumers still update */
            }
        }
    }

    private beginFetch(
        entry: CacheEntry,
        fn: FunctionReference,
        args: Record<string, unknown>,
        shardKey: string | undefined,
        pollIntervalMs: number,
    ): void {
        // Initial fetch (HTTP) so that even WS-less environments see a value.
        this.client
            .query(fn as FunctionReference, args, { shardKey })
            .then((value) => {
                entry.status = "ready";
                entry.data = value;
                entry.error = undefined;
                this.emit(entry);
            })
            .catch((error: unknown) => {
                entry.status = "error";
                entry.error = error instanceof Error ? error : new Error(String(error));
                this.emit(entry);
            });

        // Live updates via WS subscription. The client subscribes regardless;
        // if the WS implementation is missing, the subscribe call still wires
        // the callback but never receives data.
        try {
            entry.unsubscribe = this.client.subscribe(fn as FunctionReference, args, (value) => {
                entry.status = "ready";
                entry.data = value;
                entry.error = undefined;
                this.emit(entry);
            }, { shardKey });
        } catch {
            // Fallback: poll over HTTP if subscribe is unavailable in this environment.
            entry.pollTimer = setInterval(() => {
                this.client
                    .query(fn as FunctionReference, args, { shardKey })
                    .then((value) => {
                        entry.status = "ready";
                        entry.data = value;
                        entry.error = undefined;
                        this.emit(entry);
                    })
                    .catch(() => undefined);
            }, pollIntervalMs);
        }
    }
}

const cacheByClient = new WeakMap<CirrusClient, QueryCache>();

/** Returns the shared cache instance for `client`, creating it on first access. */
export const getCache = (client: CirrusClient): QueryCache => {
    let cache = cacheByClient.get(client);

    if (!cache) {
        cache = new QueryCache(client);
        cacheByClient.set(client, cache);
    }

    return cache;
};
