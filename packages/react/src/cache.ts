import type { FunctionReference, LunoraClient, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

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
 * Take a query's value off screen.
 *
 * `setQueryData(key, undefined)` cannot do this: TanStack v5 ignores an
 * `undefined` update, so the previous value stays cached, and with
 * `staleTime: Infinity` nothing refetches it. The client pushes `undefined` when
 * it blanks a subscription, most importantly when a sign-out or user switch
 * retires the previous user's session, so ignoring it kept that user's rows on
 * screen for the next one.
 *
 * Not `resetQueries` either: a reset restores the query's initial state, which
 * is the previous identity's hydrated cache value when `initialData` seeded it.
 * A snapshot still in flight is cancelled too: it was requested under the
 * credential that just went away.
 */
const blankQuery = (query: Query | undefined): void => {
    if (query === undefined) {
        return;
    }

    // Never rejects: `cancel` swallows the fetch's own cancellation error.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget: the promise only settles the cancelled fetch
    query.cancel({ silent: true });

    // eslint-disable-next-line unicorn/no-null -- TanStack's `QueryState.error` is `TError | null`; `null` is its "no error" value
    query.setState({ ...query.state, data: undefined, dataUpdatedAt: 0, error: null, fetchStatus: "idle", status: "pending" });
};

/**
 * A key's live state: whether the subscription has pushed a value, plus the
 * `queryFn`s waiting for the first one. Created on demand from either side:
 * `useQuery` can attach (and even receive its first push) before its
 * `queryFn` runs while the hydration gate holds the fetch, and the paginated
 * core runs its `queryFn` before it attaches.
 */
interface LiveValue {
    /**
     * Whether the subscription errored before its first defined value. A
     * `queryFn` that runs after that error (the hydration gate held it) has no
     * settle left to wait for, so it reads this and goes straight to HTTP.
     */
    errored: boolean;
    /** Whether a defined value has been pushed since the subscription opened or last blanked. */
    pushed: boolean;
    /** Settled with `true` on the first defined push, `false` when the subscription errors before one. */
    readonly waiters: Set<(pushed: boolean) => void>;
}

/** Settle every `queryFn` waiting on `live`'s first value. */
const settle = (live: LiveValue, pushed: boolean): void => {
    for (const waiter of live.waiters) {
        waiter(pushed);
    }

    live.waiters.clear();
};

/**
 * Wait for `live`'s next settle: `true` on a defined push, `false` when the
 * subscription errored first. Rejects when `signal` aborts.
 */
const nextPush = async (live: LiveValue, signal: AbortSignal): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
        live.waiters.add(resolve);
        // Left attached after a settle: it then deletes nothing and rejects a
        // promise that already resolved.
        signal.addEventListener(
            "abort",
            () => {
                live.waiters.delete(resolve);
                reject(signal.reason as Error);
            },
            { once: true },
        );
    });

/**
 * Per-client subscription dedup layer that sits *next to* TanStack Query.
 *
 * Where the old `QueryCache` owned both the data *and* the subscription
 * lifecycle, this adapter only owns the subscription side: data lives in the
 * TanStack {@link QueryClient}. The flow on every push is
 * `client.subscribe(fn, args, value => qc.setQueryData(queryKey, value))`.
 *
 * Every hook that mounts a `useQuery({queryKey: lunoraQueryKey(fn, args, shard)})`
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

    /** Live state per key (see `liveValue`). */
    private readonly live = new Map<string, LiveValue>();

    /** Query clients cleared on each identity change (see `clearOnIdentityChange`). */
    private readonly identityWatched = new Set<QueryClient>();

    /** Whether the single `onIdentityChange` listener is registered. */
    private listening = false;

    public constructor(private readonly client: LunoraClient) {}

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
     * The `queryFn` every hook here shares: resolve from the subscription that
     * feeds `queryKey` instead of running the query a second time over HTTP.
     * The server seeds a subscription with a full snapshot as its first frame,
     * so a mount pays for one execution, not an HTTP snapshot plus that seed —
     * and since the value IS the newest push, no older snapshot can land on top
     * of it.
     *
     * Returns the value already pushed when the subscription is live, else
     * waits for its first defined push. `fetch` (the HTTP query) runs instead
     * when nothing can push — no `WebSocket` implementation, server
     * rendering, where no effect ever attaches, or a `crossTabSync` tab that
     * is not the leader and so has no socket — or when the subscription
     * errors before its first value; a push that lands while that fallback is
     * in flight wins over its result.
     *
     * `signal` is TanStack's abort signal. Reading it makes TanStack cancel
     * (and revert) the fetch when the last observer unmounts rather than leave
     * it hanging on a push that may never come, so a remount waits afresh.
     */
    public async liveValue<T>(queryClient: QueryClient, queryKey: QueryKey, signal: AbortSignal, fetch: () => Promise<T>): Promise<T> {
        if (!("window" in globalThis) || this.client.getWebSocketImpl() === undefined) {
            return fetch();
        }

        const live = this.liveFor(keyHash(queryKey));
        // Read back, not handed through the waiter: a frame processed before this
        // continuation runs is newer still. And `pushed` alone is not enough — an
        // identity change blanks the entry directly (`clearQueries`) ahead of the
        // client's own blank push, so a blank entry waits for the next push.
        const current = live.pushed ? queryClient.getQueryData<T>(queryKey) : undefined;

        if (current !== undefined) {
            return current;
        }

        // ponytail: a cross-tab follower cannot tell whether the leader holds this
        // query, so it pays one HTTP snapshot per mount, as does a lone tab still
        // inside its first `leaderTimeout`; a relayed push still wins below.
        if (!live.errored && !this.client.isCrossTabFollower() && (await nextPush(live, signal))) {
            return this.liveValue(queryClient, queryKey, signal, fetch);
        }

        const snapshot = await fetch();

        return live.pushed ? (queryClient.getQueryData<T>(queryKey) ?? snapshot) : snapshot;
    }

    /**
     * Clear `queryClient`'s `["lunora", …]` entries whenever the client retires
     * the previous identity's session (see `LunoraClient.onIdentityChange`).
     * Idempotent per `QueryClient`, and never unsubscribed: an app can keep its
     * `QueryClient` across an unmounted `LunoraProvider`, and a sign-out in that
     * window must still clear it. The listener lives as long as the client
     * (`close()` releases it).
     *
     * The client blanks only the subscriptions still open. An entry kept for an
     * unmounted query (the 5-minute `gcTime`) hears nothing, and a remount would
     * render it with no refetch (`staleTime: Infinity`), showing the previous
     * user's rows to the next one. Entries nothing uses are removed; entries
     * still in use (an observer, or a hook fed through this registry) are blanked
     * so their observers stay attached.
     */
    public clearOnIdentityChange(queryClient: QueryClient): void {
        this.listenForIdentityChange();
        this.identityWatched.add(queryClient);
    }

    /**
     * Stop clearing `queryClient` on this client's identity changes — for when
     * a provider hands `queryClient` to a different client, whose own identity
     * changes then govern it.
     */
    public stopClearingOnIdentityChange(queryClient: QueryClient): void {
        this.identityWatched.delete(queryClient);
    }

    /**
     * `useSyncExternalStore` subscribe for the client's `identityEpoch()`:
     * registers the clearing listener first, so the previous identity's cached
     * rows are gone by the time `onChange` re-renders.
     */
    public readonly subscribeIdentityEpoch = (onChange: () => void): Unsubscribe => {
        this.listenForIdentityChange();

        return this.client.onIdentityChange(onChange);
    };

    /**
     * Register the one `onIdentityChange` listener that clears every watched
     * `QueryClient`. Idempotent. Call it before registering any listener that
     * re-renders from the cache: listeners fire in insertion order, so this one
     * must run first.
     */
    public listenForIdentityChange(): void {
        if (this.listening) {
            return;
        }

        this.listening = true;

        this.client.onIdentityChange(() => {
            for (const queryClient of this.identityWatched) {
                this.clearQueries(queryClient);
            }
        });
    }

    /**
     * Take every `["lunora", …]` entry in `queryClient` off screen: entries
     * nothing uses are removed, entries still in use (an observer, or a hook fed
     * through this registry) are blanked so their observers stay attached.
     */
    public clearQueries(queryClient: QueryClient): void {
        const cache = queryClient.getQueryCache();

        for (const query of cache.findAll({ queryKey: ["lunora"] })) {
            // Blanked either way: an observer's `placeholderData` can still hold
            // a removed query, and must find nothing in it.
            blankQuery(query);

            if (query.getObserversCount() === 0 && !this.hasConsumers(query.queryKey)) {
                cache.remove(query);
            }
        }
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
                        const live = this.liveFor(key);

                        if (value === undefined) {
                            // A blank is not a value: a refetch after a user switch must
                            // wait for the new identity's first push, not read this one.
                            live.pushed = false;
                            live.errored = false;
                            blankQuery(queryClient.getQueryCache().find({ exact: true, queryKey }));

                            return;
                        }

                        queryClient.setQueryData(queryKey, value);
                        live.pushed = true;
                        live.errored = false;
                        settle(live, true);
                    },
                    {
                        onError: (error) => {
                            const live = this.liveFor(key);

                            if (!live.pushed) {
                                live.errored = true;
                                settle(live, false);
                            }

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
                this.dropLive(key);

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
                this.dropLive(key);
            }
        };
    }

    private liveFor(key: string): LiveValue {
        let live = this.live.get(key);

        if (!live) {
            live = { errored: false, pushed: false, waiters: new Set() };
            this.live.set(key, live);
        }

        return live;
    }

    /**
     * Forget a key nothing subscribes to any more. A fetch still waiting on its
     * first push keeps the state alive: it is either cancelled through its
     * signal, or the key's next attach pushes the value it waits for.
     */
    private dropLive(key: string): void {
        const live = this.live.get(key);

        if (live === undefined) {
            return;
        }

        if (live.waiters.size === 0) {
            this.live.delete(key);
        } else {
            live.errored = false;
            live.pushed = false;
        }
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
export { lunoraQueryKey, lunoraQueryKeyFromArgsKey, serializeQueryKey } from "./query-key";
