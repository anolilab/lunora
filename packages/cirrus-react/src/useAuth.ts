import { useCallback, useState } from "react";

import { useCirrus } from "./CirrusProvider.js";
import type { UseAuthResult, User } from "./types.js";

/**
 * Lightweight token plumbing. Full auth flows (provider redirect, refresh)
 * land in Phase 6 — this hook exists so application code can call
 * `setToken(jwt)` after a sign-in and have subsequent RPC calls carry the
 * `Authorization` header.
 */
export const useAuth = (): UseAuthResult => {
    const client = useCirrus();
    const [token, setTokenState] = useState<string | null>(() => client.getAuthToken());
    // `user` is exposed for forward-compatibility; real population happens once
    // auth lands. Until then it tracks `null` regardless of token state.
    const [user] = useState<User | null>(null);

    const setToken = useCallback(
        (next: string | null): void => {
            client.setAuthToken(next);
            setTokenState(next);
        },
        [client],
    );

    return { user, token, setToken };
};
