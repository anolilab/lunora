import { useAuth } from "@clerk/react";
import type { LunoraClient } from "lunorash/client";
import { setAuthTokenProvider } from "lunorash/client";
import type { ReactNode } from "react";
import { useEffect } from "react";

/**
 * Hand Clerk's session token to Lunora, and keep it fresh.
 *
 * Clerk session tokens live 60 s. `setAuthTokenProvider` fetches a fresh one
 * shortly before each expires (with `authTokenOnUpgrade` that also reconnects
 * the live-query sockets warm, resuming from their cursors) and on
 * `onTokenExpired`. Clerk's `getToken()` resolves `null` once signed out, which
 * clears the token. Switching organization mints a token with the new `o`
 * claim, so the effect re-runs on it too.
 */
export const ClerkTokenBridge = ({ children, client }: { children: ReactNode; client: LunoraClient }): ReactNode => {
    const { getToken, isLoaded, isSignedIn, orgId, userId } = useAuth();

    useEffect(() => {
        if (!isLoaded) {
            return undefined;
        }

        if (!isSignedIn) {
            client.setAuthToken(null);

            return undefined;
        }

        return setAuthTokenProvider(client, getToken, { subject: userId });
    }, [client, getToken, isLoaded, isSignedIn, orgId, userId]);

    return children;
};
