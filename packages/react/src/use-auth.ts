"use client";

import { useState, useSyncExternalStore } from "react";

import { useCirrus } from "./cirrus-provider.js";
import type { UseAuthResult, User } from "./types.js";

/**
 * Lightweight token plumbing. Full auth flows (provider redirect, refresh)
 * land in Phase 6 — this hook exists so application code can call
 * `setToken(jwt)` after a sign-in and have subsequent RPC calls carry the
 * `Authorization` header.
 *
 * Multiple `useAuth` instances stay in sync: the token lives on the shared
 * `CirrusClient`, and we subscribe via `useSyncExternalStore` so a `setToken`
 * call from one component re-renders every mounted hook.
 */
const useAuth = (): UseAuthResult => {
    const client = useCirrus();
    // No manual memoization: React Compiler (enabled in the build) stabilises
    // these callbacks, so `useSyncExternalStore` keeps a steady subscription.
    const token = useSyncExternalStore(
        (onChange) => client.onAuthTokenChange(onChange),
        () => client.getAuthToken(),
        () => client.getAuthToken(),
    );
    // `user` is exposed for forward-compatibility; real population happens once
    // auth lands. Until then it tracks `null` regardless of token state.
    // eslint-disable-next-line unicorn/no-null -- `UseAuthResult.user` is a public exported type whose contract is `User | null`; `null` is the documented "signed-out" sentinel.
    const [user] = useState<User | null>(null);

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, token, user };
};

export default useAuth;
