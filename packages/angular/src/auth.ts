import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { LunoraClient, User } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";

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

    const unsubToken = client.onAuthTokenChange(() => {
        token.set(client.getAuthToken());
    });

    const unsubUser = store.subscribe(() => {
        user.set(store.getUser());
    });

    destroyRef.onDestroy(() => {
        unsubToken();
        unsubUser();
    });

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, token: token.asReadonly(), user: user.asReadonly() };
};
