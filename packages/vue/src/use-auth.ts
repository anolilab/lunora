import type { User } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";
import type { DeepReadonly, Ref } from "vue";
import { onScopeDispose, readonly, ref } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";

interface UseAuthResult {
    setToken: (token: string | null) => void;
    token: DeepReadonly<Ref<string | null>>;
    user: DeepReadonly<Ref<User | null>>;
}

/**
 * Token + identity plumbing for Vue. `token` is a readonly ref tracking the
 * client's auth token; `user` is a readonly ref resolved from `getCurrentUser()`
 * whenever the token changes. `setToken(jwt)` after sign-in makes subsequent
 * RPC calls carry the `Authorization` header.
 *
 * Multiple `useAuth` instances within the same effect scope share a single
 * per-client identity store (from `@lunora/client/auth`) — a `setToken` from
 * one component re-renders every watcher with the freshly-resolved user.
 *
 * Both subscribes are client-only, for the same reason as `useFlags`: this
 * runs synchronously inside `setup()` during `renderToString`, and that render
 * scope is never stopped, so `onScopeDispose` never fires. For the identity
 * subscribe that is not just a stray listener — the store kicks off
 * `getCurrentUser()` on its first subscriber, so an unguarded server render
 * issues a round-trip against a client whose URL does not resolve there. Both
 * refs still hold the client's current values; live updates start at hydration.
 */
const useAuth = (): UseAuthResult => {
    const client = useLunora();
    const store = getIdentityStore(client);

    const tokenRef = ref<string | null>(client.getAuthToken());

    const userRef = ref<User | null>(store.getUser());

    const onTokenChange = (): void => {
        tokenRef.value = client.getAuthToken();
    };

    const onUserChange = (): void => {
        userRef.value = store.getUser();
    };

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    if (!isBrowser()) {
        return { setToken, token: readonly(tokenRef), user: readonly(userRef) };
    }

    const unsubToken = client.onAuthTokenChange(onTokenChange);
    const unsubUser = store.subscribe(onUserChange);

    onScopeDispose(() => {
        unsubToken();
        unsubUser();
    });

    return { setToken, token: readonly(tokenRef), user: readonly(userRef) };
};

export type { UseAuthResult };
export { useAuth };
