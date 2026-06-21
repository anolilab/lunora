"use client";

import { useSyncExternalStore } from "react";

import { useLunora } from "./lunora-provider";
import type { LunoraClient, UseAuthResult, User } from "./types";

/**
 * Per-client identity store. The authenticated user lives on the shared
 * `LunoraClient`, but the client itself is framework-agnostic and exposes only
 * an async `getCurrentUser()` plus `onAuthTokenChange`. This module bridges that
 * to React's `useSyncExternalStore`: one store per client holds the last
 * resolved `user`, the set of mounted-hook listeners, and the token-change
 * subscription — so every mounted `useAuth` re-renders together when identity
 * resolves, and a single fetch is shared across them.
 *
 * The store's `subscribe`/`getSnapshot` are created once per client and cached
 * (so React keeps a steady `useSyncExternalStore` subscription rather than
 * resubscribing every render), and the store lives for the client's lifetime —
 * the WeakMap lets it be GC'd once the client itself is dropped.
 */
interface IdentityStore {
    getSnapshot: () => User | null;
    subscribe: (onChange: () => void) => () => void;
}

// WeakMap keyed by client so a discarded client's store is GC'd with it.
const stores = new WeakMap<LunoraClient, IdentityStore>();

const createStore = (client: LunoraClient): IdentityStore => {
    const listeners = new Set<() => void>();
    // eslint-disable-next-line unicorn/no-null -- `user` is `User | null`; `null` is the signed-out sentinel
    let user: User | null = null;

    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };

    // Generation guards against a slow fetch resolving after a newer token
    // change has superseded it (last-write-wins across network races).
    let generation = 0;

    const setUser = (next: User | null): void => {
        if (user !== next) {
            user = next;
            notify();
        }
    };

    const refresh = (): void => {
        generation += 1;
        const current = generation;

        // A cleared token short-circuits to signed-out without a round-trip so
        // sign-out is reflected immediately.
        if (client.getAuthToken() === null) {
            // eslint-disable-next-line unicorn/no-null -- signed-out sentinel
            setUser(null);

            return;
        }

        client
            .getCurrentUser()
            .then((next) => {
                if (current === generation) {
                    setUser(next);
                }

                return undefined;
            })
            .catch(() => {
                if (current === generation) {
                    // eslint-disable-next-line unicorn/no-null -- failed resolve ⇒ signed out
                    setUser(null);
                }
            });
    };

    // Refetch identity whenever the token changes (sign-in / sign-out / rotate).
    // The subscription is scoped to having at least one mounted hook: registered
    // when the first `useAuth` subscribes and torn down when the last unmounts,
    // so the listener (and its fetch-on-change side effect) doesn't dangle on the
    // client after every hook is gone. The store object itself stays cached in
    // the WeakMap for the client's lifetime — the `user` snapshot survives across
    // unmount/remount, preserving the cross-mount caching contract; only the live
    // token subscription comes and goes with subscriber presence.
    let unsubscribeToken: (() => void) | undefined;

    return {
        getSnapshot: () => user,
        subscribe: (onChange: () => void) => {
            const firstSubscriber = listeners.size === 0;

            listeners.add(onChange);

            // Wire the token listener for the first active subscriber, and run the
            // initial identity resolve once for the store's lifetime. Subsequent
            // mounts reuse the cached value (the live subscription keeps it fresh)
            // — no redundant round-trip per hook instance.
            if (firstSubscriber) {
                unsubscribeToken = client.onAuthTokenChange(refresh);

                // Resolve identity on the first mount, and re-resolve on a
                // remount after a full unmount — while no hook was subscribed the
                // token listener was detached, so a token change in that window
                // would otherwise be missed.
                refresh();
            }

            return () => {
                listeners.delete(onChange);

                // Last subscriber left: drop the token listener so it no longer
                // fires (the cached `user` snapshot is retained for a remount).
                if (listeners.size === 0) {
                    unsubscribeToken?.();
                    unsubscribeToken = undefined;
                }
            };
        },
    };
};

const getStore = (client: LunoraClient): IdentityStore => {
    let store = stores.get(client);

    if (!store) {
        store = createStore(client);
        stores.set(client, store);
    }

    return store;
};

/**
 * Token + identity plumbing. The token lives on the shared `LunoraClient`;
 * `setToken(jwt)` after a sign-in makes subsequent RPC calls carry the
 * `Authorization` header. `user` is resolved from better-auth's `get-session`
 * endpoint via `client.getCurrentUser()` — fetched on mount and refetched
 * whenever the token changes (`onAuthTokenChange`), and `null` when signed out.
 *
 * Multiple `useAuth` instances stay in sync: both `token` and `user` are read
 * through `useSyncExternalStore` over the shared client (and a per-client
 * identity store), so a `setToken` from one component re-renders every mounted
 * hook with the freshly-resolved user.
 */
const useAuth = (): UseAuthResult => {
    const client = useLunora();
    const store = getStore(client);

    // No manual memoization: React Compiler (enabled in the build) stabilises
    // these callbacks, so `useSyncExternalStore` keeps a steady subscription.
    const token = useSyncExternalStore(
        (onChange) => client.onAuthTokenChange(onChange),
        () => client.getAuthToken(),
        () => client.getAuthToken(),
    );

    const user = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        // Server snapshot: no identity resolved during SSR.
        // eslint-disable-next-line unicorn/no-null -- `UseAuthResult.user` contract is `User | null`
        () => null,
    );

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, token, user };
};

export default useAuth;
