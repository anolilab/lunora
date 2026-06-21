import type { User } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";
import type { Accessor, JSX } from "solid-js";
import { createSignal, onCleanup, Show } from "solid-js";

import { useLunora } from "./context";

interface UseAuthResult {
    setToken: (token: string | null) => void;
    token: Accessor<string | null>;
    user: Accessor<User | null>;
}

/**
 * Token + identity plumbing for Solid. Returns `{ token, user, setToken }`
 * where `token` and `user` are fine-grained signals. `setToken(jwt)` after
 * sign-in updates the shared client token; `user` resolves asynchronously via
 * `client.getCurrentUser()` and updates on every token change.
 */
const createAuth = (): UseAuthResult => {
    const client = useLunora();
    const store = getIdentityStore(client);

    const [token, setTokenSignal] = createSignal<string | null>(client.getAuthToken());

    const [user, setUserSignal] = createSignal<User | null>(store.getUser());

    const unsubToken = client.onAuthTokenChange((next) => {
        setTokenSignal(() => next);
    });

    const unsubUser = store.subscribe(() => {
        setUserSignal(() => store.getUser());
    });

    onCleanup(() => {
        unsubToken();
        unsubUser();
    });

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, token, user };
};

// Auth-gate helpers — idiomatic Solid: plain function components using Show.

interface AuthGateProps {
    children: JSX.Element;
}

/**
 * Render `children` only after authentication has settled and a token + user
 * are both present.
 */
const Authenticated = (props: AuthGateProps): JSX.Element => {
    const { token, user } = createAuth();

    return <Show when={token() === null ? false : user() !== null}>{props.children}</Show>;
};

/**
 * Render `children` while authentication is still in progress — token is set
 * but the user has not yet resolved.
 */
const AuthLoading = (props: AuthGateProps): JSX.Element => {
    const { token, user } = createAuth();

    return <Show when={token() === null ? false : user() === null}>{props.children}</Show>;
};

/**
 * Render `children` only when auth has settled and no token is present (the
 * signed-out state).
 */
const Unauthenticated = (props: AuthGateProps): JSX.Element => {
    const { token, user } = createAuth();

    return <Show when={token() === null ? user() === null : false}>{props.children}</Show>;
};

export type { UseAuthResult };
export { Authenticated, AuthLoading, createAuth, Unauthenticated };
