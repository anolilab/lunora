import type { User } from "@lunora/client";
import type { AuthStatus } from "@lunora/client/auth";
import { getIdentityStore, isAuthenticatedStatus, isLoadingStatus } from "@lunora/client/auth";
import type { Readable } from "svelte/store";
import { derived, readable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { getLunoraClient } from "./context";

interface AuthStore {
    /** Set the auth token on the underlying `LunoraClient`. */
    setToken: (token: string | null) => void;

    /**
     * Readable store of the resolved auth state. Branch on this, not on
     * `$user === null` — see the contract in `@lunora/client/auth`; `user` is
     * `null` both when signed out and when a held credential's identity could
     * not be resolved.
     */
    status: Readable<AuthStatus>;
    /** Readable store of the auth token (`null` when signed out). */
    token: Readable<string | null>;
    /** Readable store of the resolved user (`null` when signed out or still loading). */
    user: Readable<User | null>;
}

/**
 * Create a pair of Svelte readable stores tracking the auth token and the
 * resolved user identity. The stores are lazy: subscriptions open on the first
 * reader and close when the last unsubscribes. Calling `setToken(jwt)` after
 * sign-in refreshes both stores.
 *
 * Both subscribes are client-only, like every other subscribing primitive here:
 * `$token` / `$user` in a template subscribe during `renderToString`. For the
 * user store that is not just a stray listener — the identity store kicks off
 * `getCurrentUser()` on its first subscriber, so an unguarded server render
 * issues a round-trip against a client whose URL does not resolve there. Both
 * stores still report the client's current values on the server; only the live
 * updates are withheld, until hydration.
 *
 * Pass an explicit client to bypass the ambient context (useful in tests).
 */
const auth = (explicitClient?: ReturnType<typeof getLunoraClient>): AuthStore => {
    const client = explicitClient ?? getLunoraClient();
    const store = getIdentityStore(client);

    const token = readable<string | null>(client.getAuthToken(), (set) => {
        set(client.getAuthToken());

        if (!isBrowser()) {
            return () => {};
        }

        return client.onAuthTokenChange((next) => {
            set(next);
        });
    });

    const user = readable<User | null>(store.getUser(), (set) => {
        set(store.getUser());

        if (!isBrowser()) {
            return () => {};
        }

        return store.subscribe(() => {
            set(store.getUser());
        });
    });

    const status = readable<AuthStatus>(store.getStatus(), (set) => {
        set(store.getStatus());

        if (!isBrowser()) {
            return () => {};
        }

        return store.subscribe(() => {
            set(store.getStatus());
        });
    });

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, status, token, user };
};

/** Derived auth-gate stores for template gating (`{#if $isAuthenticated}`), built on {@link auth}. */
interface AuthGateStore {
    /** Readable store, `true` once a credential is held and nothing has contradicted it. */
    isAuthenticated: Readable<boolean>;

    /** Readable store, `true` while a credential's first identity resolve is in flight. */
    isLoading: Readable<boolean>;
}

/**
 * Derived auth-gate stores built on {@link auth}. Svelte has no JSX-style
 * `Authenticated` slot component the way React/Vue/Solid do (this package is
 * plain `.ts` over stores — no `.svelte` component compiler required), so this
 * exposes the same three-state logic as two boolean stores instead, mapped from
 * the shared `AuthStatus` contract in `@lunora/client/auth`: a credential whose
 * first identity resolve is in flight is `isLoading`; a credential nothing has
 * contradicted — including one whose identity endpoint is unreachable — is
 * `isAuthenticated`; no session is neither (the signed-out state a template
 * checks for with a plain `{:else}`).
 *
 * ```ts
 * import { authGate } from "@lunora/svelte";
 * const { isAuthenticated, isLoading } = authGate();
 * // markup: {#if $isAuthenticated} signed in {:else if $isLoading} loading… {:else} signed out {/if}
 * ```
 *
 * Pass an explicit client to bypass the ambient context (useful in tests).
 */
const authGate = (explicitClient?: ReturnType<typeof getLunoraClient>): AuthGateStore => {
    const { status } = auth(explicitClient);

    const isLoading = derived(status, ($status) => isLoadingStatus($status));
    const isAuthenticated = derived(status, ($status) => isAuthenticatedStatus($status));

    return { isAuthenticated, isLoading };
};

export type { AuthGateStore, AuthStore };
export { auth, authGate };
