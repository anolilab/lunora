import type { User } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";
import type { Accessor } from "solid-js";
import { createComponent, createSignal, onCleanup, Show } from "solid-js";

import { useLunora } from "./context";
import type { SolidChildren, SolidElement } from "./solid-compat";

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

// Auth-gate helpers — plain function components over `Show`, which both Solid
// majors export unchanged from the package root.

interface AuthGateProps {
    children: SolidChildren;
}

/** An auth-gate component: renders its children only while the gate's condition holds. */
type AuthGate = (props: AuthGateProps) => SolidElement;

/**
 * `Show` viewed as the one overload the gates use: a truthiness test with plain
 * (non-function, non-keyed) children.
 *
 * Both majors ship `Show` as a set of overloads whose first entry requires
 * `keyed`, and overload resolution outside JSX picks that one — and the
 * overload sets themselves differ between 1.x and 2.0. Narrowing to the single
 * shape this file actually uses is what keeps one source compiling against
 * either major.
 */
const ShowWhen = Show as unknown as (props: { children: SolidChildren; when: unknown }) => SolidElement;

/**
 * Build an auth gate that renders `children` only while `matches` holds.
 *
 * Written with `createComponent` rather than JSX so this package can ship one
 * build for Solid 1.x and 2.0 — the two majors compile JSX against different
 * runtimes (`solid-js/web` vs `@solidjs/web`), while `createComponent` is
 * exported from the `solid-js` root in both. The `get` accessors preserve JSX's
 * laziness, so `when` is re-read whenever the underlying signals change.
 */
const authGate =
    (matches: (auth: UseAuthResult) => boolean): AuthGate =>
    (props: AuthGateProps): SolidElement => {
        const auth = createAuth();

        return createComponent(ShowWhen, {
            get children() {
                return props.children;
            },
            get when() {
                return matches(auth);
            },
        });
    };

/**
 * Render `children` only after authentication has settled and a token + user
 * are both present.
 */
const Authenticated: AuthGate = authGate(({ token, user }) => (token() === null ? false : user() !== null));

/**
 * Render `children` while authentication is still in progress — token is set
 * but the user has not yet resolved.
 */
const AuthLoading: AuthGate = authGate(({ token, user }) => (token() === null ? false : user() === null));

/**
 * Render `children` only when auth has settled and no token is present (the
 * signed-out state).
 */
const Unauthenticated: AuthGate = authGate(({ token, user }) => (token() === null ? user() === null : false));

export type { UseAuthResult };
export { Authenticated, AuthLoading, createAuth, Unauthenticated };
