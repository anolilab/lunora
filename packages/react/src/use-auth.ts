"use client";

import { getIdentityStore } from "@lunora/client/auth";
import { useSyncExternalStore } from "react";

import { useLunora } from "./lunora-provider";
import type { UseAuthResult } from "./types";

/**
 * Token + identity plumbing. The token lives on the shared `LunoraClient`;
 * `setToken(jwt)` after a sign-in makes subsequent RPC calls carry the
 * `Authorization` header. `user` and `status` come from the framework-agnostic
 * per-client identity store in `@lunora/client/auth` — the same store Vue,
 * Solid, Svelte and Angular read, so all five agree on what "authenticated"
 * means rather than each keeping a private copy of the resolve logic.
 *
 * `status` is the value to branch on: `user` is `null` both when signed out and
 * when a held credential's identity endpoint could not be reached. See the
 * contract documented on `AuthStatus`.
 *
 * Multiple `useAuth` instances stay in sync: token, user and status are all read
 * through `useSyncExternalStore` over the shared client and its identity store,
 * so a `setToken` from one component re-renders every mounted hook.
 */
const useAuth = (): UseAuthResult => {
    const client = useLunora();
    const store = getIdentityStore(client);

    // No manual memoization: React Compiler (enabled in the build) stabilises
    // these callbacks, and the store's own members are stable per client, so
    // `useSyncExternalStore` keeps a steady subscription.
    const token = useSyncExternalStore(
        (onChange) => client.onAuthTokenChange(onChange),
        () => client.getAuthToken(),
        () => client.getAuthToken(),
    );

    const user = useSyncExternalStore(
        store.subscribe,
        store.getUser,
        // Server snapshot: no identity resolved during SSR.
        // eslint-disable-next-line unicorn/no-null -- `UseAuthResult.user` contract is `User | null`
        () => null,
    );

    // Server snapshot: SSR renders the loading branch, and the first hydration
    // render agrees with it, so no signed-out UI flashes in before the store's
    // first resolve lands.
    const status = useSyncExternalStore(store.subscribe, store.getStatus, () => "loading" as const);

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, status, token, user };
};

export default useAuth;
