import type { User } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";
import type { Readable } from "svelte/store";
import { readable } from "svelte/store";

import { getLunoraClient } from "./context";

interface AuthStore {
    /** Set the auth token on the underlying `LunoraClient`. */
    setToken: (token: string | null) => void;
    /** Readable store of the auth token (`null` when signed out). */
    token: Readable<string | null>;
    /** Readable store of the resolved user (`null` when signed out or still loading). */
    user: Readable<User | null>;
}

/**
 * Create a pair of Svelte readable stores tracking the auth token and the
 * resolved user identity. The stores are lazy: subscriptions open on the first
 * reader and close when the last unsubscribes. Calling `setToken(jwt)` after
 * sign-in refreshes both stores.
 *
 * Pass an explicit client to bypass the ambient context (useful in tests).
 */
const auth = (explicitClient?: ReturnType<typeof getLunoraClient>): AuthStore => {
    const client = explicitClient ?? getLunoraClient();
    const store = getIdentityStore(client);

    const token = readable<string | null>(client.getAuthToken(), (set) => {
        set(client.getAuthToken());
        const unsub = client.onAuthTokenChange((next) => {
            set(next);
        });

        return unsub;
    });

    const user = readable<User | null>(store.getUser(), (set) => {
        set(store.getUser());
        const unsub = store.subscribe(() => {
            set(store.getUser());
        });

        return unsub;
    });

    const setToken = (next: string | null): void => {
        client.setAuthToken(next);
    };

    return { setToken, token, user };
};

export type { AuthStore };
export { auth };
