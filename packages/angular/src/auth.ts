import type { Signal } from "@angular/core";
import { computed, DestroyRef, inject, signal } from "@angular/core";
import type { LunoraClient, User } from "@lunora/client";
import type { AuthStatus } from "@lunora/client/auth";
import { getIdentityStore, isAuthenticatedStatus, isLoadingStatus } from "@lunora/client/auth";

import { resolveLunoraClient } from "./client";

/**
 * `AuthOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface AuthOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /** `DestroyRef` whose `onDestroy` removes the listeners. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;
}

/**
 * `AuthResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface AuthResult {
    /** Set the auth token (sign-in / sign-out). */
    setToken: (token: string | null) => void;

    /**
     * The resolved auth state. Branch on this, not on `user() === null` — see the
     * contract in `@lunora/client/auth`; `user` is `null` both when signed out
     * and when a held credential's identity could not be resolved.
     */
    status: Signal<AuthStatus>;

    /** The current auth token, or `null`. */
    token: Signal<string | null>;

    /** The resolved user from `store.getUser()`, or `null`. */
    user: Signal<User | null>;
}

/**
 * Token + identity plumbing for Angular. `token` is a signal tracking the
 * client's auth token; `user` is a signal resolved from `getCurrentUser()`
 * whenever the token changes. `setToken(jwt)` after sign-in makes subsequent
 * RPC calls carry the `Authorization` header.
 *
 * Multiple `auth` instances on the same client share a single per-client
 * identity store (from `@lunora/client/auth`) — a `setToken` from one component
 * re-renders every watcher with the freshly-resolved user.
 *
 * Call from an injection context (component/service field or constructor):
 * ```ts
 * const { token, user, setToken } = auth();
 * ```
 * @experimental
 */
export const auth = (options: AuthOptions = {}): AuthResult => {
    const client = resolveLunoraClient(options.client);
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const store = getIdentityStore(client);

    const token = signal<string | null>(client.getAuthToken());
    const user = signal<User | null>(store.getUser());
    const status = signal<AuthStatus>(store.getStatus());

    const unsubToken = client.onAuthTokenChange(() => {
        token.set(client.getAuthToken());
    });

    const unsubUser = store.subscribe(() => {
        user.set(store.getUser());
        status.set(store.getStatus());
    });

    destroyRef.onDestroy(() => {
        unsubToken();
        unsubUser();
    });

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, status: status.asReadonly(), token: token.asReadonly(), user: user.asReadonly() };
};

/**
 * `AuthGateResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface AuthGateResult {
    /** `true` once a credential is held and nothing has contradicted it. */
    isAuthenticated: Signal<boolean>;

    /** `true` while a credential's first identity resolve is in flight. */
    isLoading: Signal<boolean>;
}

/**
 * Derived auth-gate signals for template gating (Angular's `\@if` control
 * flow), built on {@link auth}. Angular has no JSX-style `Authenticated` slot
 * component the way React/Vue/Solid do, so this exposes the same three-state
 * logic as two booleans instead, mapped from the shared `AuthStatus` contract in
 * `@lunora/client/auth`: a credential whose first identity resolve is in flight
 * is `isLoading`; a credential nothing has contradicted — including one whose
 * identity endpoint is unreachable — is `isAuthenticated`; no session is neither
 * (the signed-out state a template checks for with a plain `\@else`).
 *
 * Call from an injection context (component/service field or constructor):
 * ```ts
 * protected readonly authState = authGate();
 * // template: \@if (authState.isAuthenticated()) { ... } \@else if (authState.isLoading()) { ... }
 * ```
 * @experimental
 */
export const authGate = (options: AuthOptions = {}): AuthGateResult => {
    const { status } = auth(options);

    const isLoading = computed(() => isLoadingStatus(status()));
    const isAuthenticated = computed(() => isAuthenticatedStatus(status()));

    return { isAuthenticated, isLoading };
};
