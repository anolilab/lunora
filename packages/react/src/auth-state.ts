"use client";

import { useSyncExternalStore } from "react";

import useAuth from "./use-auth";

/**
 * Resolved auth-gate state. `isLoading` covers the window before the client has
 * hydrated — the server render and the first hydration render both report
 * loading, so the markup agrees and no signed-out UI flashes in.
 */
interface AuthState {
    isAuthenticated: boolean;
    isLoading: boolean;
}

/** `useSyncExternalStore` with a never-firing store: the server snapshot is `false` and the client snapshot is `true`, so it flips to `true` exactly once after hydration without a setState-in-effect. */
const subscribe = (): (() => void) => () => undefined;

/**
 * Three-state auth status for gating UI. Reports `isLoading` until the client
 * has hydrated, then `isAuthenticated` tracks whether a token is set on the
 * shared client.
 *
 * Cirrus auth is token-based and resolves synchronously once the token is
 * known, so the loading window is hydration rather than a server round-trip —
 * use it (via {@link AuthState}) to render a fallback while it settles.
 */
const useAuthState = (): AuthState => {
    const { token } = useAuth();
    const hydrated = useSyncExternalStore(
        subscribe,
        () => true,
        () => false,
    );

    return { isAuthenticated: hydrated && token !== null, isLoading: !hydrated };
};

export type { AuthState };
export { useAuthState };
