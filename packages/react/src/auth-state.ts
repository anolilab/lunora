"use client";

import { isAuthenticatedStatus, isLoadingStatus } from "@lunora/client/auth";

import useAuth from "./use-auth";

/**
 * Resolved auth-gate state, derived from the shared `AuthStatus` contract in
 * `@lunora/client/auth` — the same mapping Vue, Solid, Svelte and Angular use.
 */
interface AuthState {
    isAuthenticated: boolean;
    isLoading: boolean;
}

/**
 * Three-state auth status for gating UI.
 *
 * `isLoading` covers the server render and the first hydration render (the
 * identity store's server snapshot is `"loading"`, so the markup agrees and no
 * signed-out UI flashes in) as well as the window where a credential is held and
 * its first identity resolve is still in flight.
 *
 * `isAuthenticated` follows the credential, not the identity record: an
 * unreachable identity endpoint keeps the gate open with `user === null`. A UI
 * that needs to tell that apart reads `useAuth().status`.
 */
const useAuthState = (): AuthState => {
    const { status } = useAuth();

    return { isAuthenticated: isAuthenticatedStatus(status), isLoading: isLoadingStatus(status) };
};

export type { AuthState };
export { useAuthState };
