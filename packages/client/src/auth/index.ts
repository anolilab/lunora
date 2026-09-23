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
 * | `unauthenticated`  | the server answered that there is no session                     | signed out      |
 * | `loading`          | the first identity resolve is in flight                          | loading         |
 * | `authenticated`    | the server returned a user                                       | authenticated   |
 * | `unreachable`      | a credential is held but the identity endpoint could not be reached | authenticated |
 *
 * No row says "no bearer token". A **cookie session carries no token here** —
 * it is better-auth's default, what `@lunora/auth-ui` is built on, and what
 * `examples/auth-playground` ships (`createAuthClient` plus
 * `new LunoraClient({ url })`, never `setAuthToken`). Answering
 * `unauthenticated` off a null token alone declared every user of every such
 * app signed out without asking the server, which also left
 * `LunoraClient`'s identity fingerprint `null` for all of them — and a
 * fingerprint that is `null` for everyone is what turns the offline-queue,
 * read-cache and socket identity gates into `null === null`. The first resolve
 * therefore ALWAYS asks; only after an answer does a cleared token
 * short-circuit.
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
 * Every {@link AuthStatus}, as a value — the contract table in this module's
 * header, and the `@lunora/client` docs table that restates it for consumers,
 * are both asserted against this list (`auth-status-docs.test.ts`), so a new
 * state cannot ship undocumented.
 */
const AUTH_STATUSES = ["authenticated", "loading", "unauthenticated", "unreachable"] as const;

/**
 * Resolved authentication state. See the contract table in this module's header
 * — the states are not interchangeable, and `unreachable` is the one that exists
 * only so "the server said no session" and "we could not ask" stop colliding.
 */
type AuthStatus = (typeof AUTH_STATUSES)[number];

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
    // Never `unauthenticated` before the server has been asked — see the module
    // header. Every adapter's SSR snapshot is already `"loading"`, so this is
    // also the value the first hydration render agrees with.
    let status: AuthStatus = "loading";
    let started = false;
    // Whether the server has ANSWERED at least once for this store. Until it
    // has, a null token is not evidence of anything (a cookie session holds no
    // token here); after it has, a cleared token is a sign-out and reflects
    // without a round trip.
    //
    // Set only where an answer lands, never where one is asked for: a probe
    // that rejects (the endpoint was unreachable) learned nothing, and marking
    // it answered turned the next `refresh` — the one the reconnect fires to
    // recover from `unreachable` — into an instant `unauthenticated` off the
    // absent bearer token, with no second request ever made. A cookie session
    // whose first `/get-session` missed stayed signed out for the life of the
    // page, `identityFingerprint()` null with it.
    let answered = false;

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
        // sign-out is reflected immediately — but only ONCE the server has
        // answered this store at least once. The first resolve always asks,
        // because a cookie session (better-auth's default) holds no token here
        // and would otherwise be reported signed out for the whole session,
        // leaving `identityFingerprint()` null for every user of the app.
        if (client.getAuthToken() === null && answered) {
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
                    // The server answered, and this is still the current
                    // question — the only place a cleared token earns the right
                    // to short-circuit a later resolve.
                    answered = true;
                    setState(next === null ? "unauthenticated" : "authenticated", next);
                }

                return undefined;
            })
            .catch(() => {
                if (current === generation) {
                    // The endpoint could not be reached. Whatever credential the
                    // app has — a bearer token, or a cookie this code cannot see
                    // — is still held and nothing contradicted it, so stay
                    // authenticated and keep whatever user was last resolved.
                    // Nothing is granted by this: every identity gate refuses a
                    // `null` fingerprint, so an unreachable resolve seeds no
                    // cached read and replays no queued write.
                    setState("unreachable", user);
                }
            });
    };

    // This app has auth, as of now. Declared at ATTACH rather than at the first
    // resolve: `refresh` waits for a subscriber, and a `useQuery` that mounts
    // ahead of the auth gate (or `hydrateOnStart`'s reseed) runs in between —
    // with the client otherwise unable to tell this from an app that has no
    // auth at all and whose `null` identity really is its own.
    client.expectIdentityResolution();

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
export { AUTH_STATUSES, getIdentityStore, isAuthenticatedStatus, isLoadingStatus };
