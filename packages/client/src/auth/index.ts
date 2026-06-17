/**
 * `@lunora/client/auth` — framework-agnostic identity store.
 *
 * The `LunoraClient` is framework-neutral and exposes auth through an async
 * `getCurrentUser()` plus `onAuthTokenChange`. This module lifts the per-client
 * identity caching and listener-fan-out into a shared store that every UI
 * adapter (React, Vue, Solid, Svelte) can consume, so only one fetch runs at a
 * time and all mounted hooks re-render together when identity resolves or the
 * token changes.
 */

import type { LunoraClient } from "../lunora-client";
import type { User } from "../types";

interface IdentityStore {
    /** Read the current resolved user, or `null` when signed out / not yet resolved. */
    getUser: () => User | null;

    /**
     * Subscribe to identity changes. `onChange` is called whenever the user or
     * token changes. Returns an unsubscribe handle.
     */
    subscribe: (onChange: () => void) => () => void;
}

// WeakMap keyed by client so a discarded client's store is GC'd with it.
const stores = new WeakMap<LunoraClient, IdentityStore>();

const createIdentityStore = (client: LunoraClient): IdentityStore => {
    const listeners = new Set<() => void>();
    // eslint-disable-next-line unicorn/no-null -- `user` is `User | null`; `null` is the signed-out sentinel
    let user: User | null = null;
    let started = false;

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
    // Registered once for the store's lifetime, independent of UI framework subscribers.
    client.onAuthTokenChange(refresh);

    return {
        getUser: () => user,
        subscribe: (onChange: () => void) => {
            listeners.add(onChange);

            // First mount kicks off the initial identity resolve. Subsequent
            // mounts reuse the cached value (and the live token subscription
            // keeps it fresh) — no redundant round-trip per hook instance.
            if (!started) {
                started = true;
                refresh();
            }

            return () => {
                listeners.delete(onChange);
            };
        },
    };
};

/**
 * Return the per-client identity store, creating it on first access.
 *
 * The store is cached via a `WeakMap` so it is GC'd when the client is dropped,
 * and creation is idempotent — calling this multiple times with the same client
 * returns the same store, keeping the single-fetch / fan-out invariant.
 */
const getIdentityStore = (client: LunoraClient): IdentityStore => {
    let store = stores.get(client);

    if (!store) {
        store = createIdentityStore(client);
        stores.set(client, store);
    }

    return store;
};

export type { IdentityStore };
export { getIdentityStore };
