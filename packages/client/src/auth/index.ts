/**
 * `@lunora/client/auth` — framework-agnostic identity store, and the auth-gate
 * contract every UI adapter implements.
 *
 * The `LunoraClient` is framework-neutral and exposes auth through an async
 * `getCurrentUser()` plus `onAuthTokenChange`. This module lifts the per-client
 * identity caching and listener-fan-out into a shared store that every UI
 * adapter (React, Vue, Solid, Svelte, Angular) consumes, so only one fetch runs
 * at a time and all mounted hooks re-render together when identity resolves or
 * the token changes.
 *
 * ## The auth-gate contract
 *
 * **Read this before adding or changing a gate in any adapter.** Five adapters
 * expose the same three-state gate, and they must agree on what each state
 * means; deriving a gate from `user !== null` (or from the token alone) is how
 * they last disagreed. The single source of truth is {@link AuthStatus}, and the
 * two predicates {@link isAuthenticatedStatus} / {@link isLoadingStatus} — an
 * adapter maps its reactive primitive onto those and adds nothing of its own.
 *
 * | status             | meaning                                                          | gate            |
 * | ------------------ | ---------------------------------------------------------------- | --------------- |
 * | `unauthenticated`  | no credential, or the server answered that there is no session   | signed out      |
 * | `loading`          | a credential is held and the first identity resolve is in flight | loading         |
 * | `authenticated`    | a credential is held and the server returned a user              | authenticated   |
 * | `unreachable`      | a credential is held but the identity endpoint could not be reached | authenticated |
 *
 * `unreachable` counts as authenticated because the **credential** is what
 * authorises requests; a failed identity round-trip is a fact about the network,
 * not about the session. Treating it as signed out turns every offline reload
 * into a sign-out, and treating it as loading spins a fallback for the whole
 * offline period — both of which shipped.
 *
 * The consequence a UI has to respect: `user` may be `null` while the gate says
 * authenticated. Branch on `status`, never on `user === null`, to tell "signed
 * out" from "signed in, identity not resolved yet".
 */

import type { LunoraClient } from "../lunora-client";
import type { User } from "../types";

/**
 * Resolved authentication state. See the contract table in this module's header
 * — the states are not interchangeable, and `unreachable` is the one that exists
 * only so "the server said no session" and "we could not ask" stop colliding.
 */
type AuthStatus = "authenticated" | "loading" | "unauthenticated" | "unreachable";

/**
 * Whether a gate should render its authenticated branch.
 *
 * Both `authenticated` and `unreachable` qualify: the credential is held in
 * either case, and only the identity round-trip differs.
 */
const isAuthenticatedStatus = (status: AuthStatus): boolean => status === "authenticated" || status === "unreachable";

/** Whether a gate should render its loading branch — the first resolve only. */
const isLoadingStatus = (status: AuthStatus): boolean => status === "loading";

interface IdentityStore {
    /** The current {@link AuthStatus} — what a gate branches on. */
    getStatus: () => AuthStatus;

    /**
     * The last resolved user, or `null`. `null` does NOT mean signed out on its
     * own: read `getStatus` for that. A user resolved before the endpoint
     * went unreachable is retained, so the UI keeps rendering the identity it
     * last knew instead of blanking.
     */
    getUser: () => User | null;

    /**
     * Subscribe to identity changes. `onChange` is called whenever the user or
     * the status changes. Returns an unsubscribe handle.
     */
    subscribe: (onChange: () => void) => () => void;
}

// WeakMap keyed by client so a discarded client's store is GC'd with it.
const stores = new WeakMap<LunoraClient, IdentityStore>();

const createIdentityStore = (client: LunoraClient): IdentityStore => {
    const listeners = new Set<() => void>();
    // eslint-disable-next-line unicorn/no-null -- `user` is `User | null`; `null` is "no user record held"
    let user: User | null = null;
    let status: AuthStatus = client.getAuthToken() === null ? "unauthenticated" : "loading";
    let started = false;

    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };

    // Generation guards against a slow fetch resolving after a newer token
    // change has superseded it (last-write-wins across network races).
    let generation = 0;

    const setState = (nextStatus: AuthStatus, nextUser: User | null): void => {
        if (status !== nextStatus || user !== nextUser) {
            status = nextStatus;
            user = nextUser;
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
            setState("unauthenticated", null);

            return;
        }

        // Only a resolve with nothing to show reads as loading. A token rotation
        // while a user is already on screen keeps the gate open rather than
        // flickering through the loading branch and back.
        setState(user === null ? "loading" : "authenticated", user);

        client
            .getCurrentUser()
            .then((next) => {
                if (current === generation) {
                    setState(next === null ? "unauthenticated" : "authenticated", next);
                }

                return undefined;
            })
            .catch(() => {
                if (current === generation) {
                    // The endpoint could not be reached. The credential is still
                    // held and nothing contradicted it, so stay authenticated and
                    // keep whatever user was last resolved.
                    setState("unreachable", user);
                }
            });
    };

    // Refetch identity whenever the token changes (sign-in / sign-out / rotate).
    // Registered once for the store's lifetime, independent of UI framework subscribers.
    client.onAuthTokenChange(refresh);

    // Recover from `unreachable` when the live socket comes back — nothing else
    // would, and the status would otherwise stay stale for the whole session.
    // `onConnectionStatus` fires immediately with the current status, which at
    // construction is never `unreachable`, so this cannot double-fire the first
    // resolve. An app that opens no socket at all never reaches `"connected"`
    // and recovers on its next token change instead.
    client.onConnectionStatus((next) => {
        if (next === "connected" && status === "unreachable") {
            refresh();
        }
    });

    return {
        getStatus: () => status,
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

export type { AuthStatus, IdentityStore };
export { getIdentityStore, isAuthenticatedStatus, isLoadingStatus };
