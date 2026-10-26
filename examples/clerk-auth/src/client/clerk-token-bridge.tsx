import { useAuth } from "@clerk/react";
import type { LunoraClient } from "lunorash/client";
import type { ReactNode } from "react";
import { useEffect } from "react";

/**
 * Hand Clerk's session token to Lunora, and keep it fresh.
 *
 * Clerk session tokens live 60 s; `getToken()` returns a cached one and
 * refreshes it in the background. When the server refuses an expired token
 * (HTTP `TOKEN_EXPIRED`, socket close 4001) `onTokenExpired` fires, and the
 * fresh token is handed over: HTTP calls retry with it and sockets reconnect
 * warm, resuming from their cursors. Switching organization mints a token with
 * the new `o` claim, so it re-runs too.
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

        let cancelled = false;

        const refresh = async (): Promise<void> => {
            const token = await getToken();

            if (!cancelled) {
                client.setAuthToken(token, userId);
            }
        };

        void refresh();

        const unsubscribe = client.onTokenExpired(() => {
            void refresh();
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [client, getToken, isLoaded, isSignedIn, orgId, userId]);

    return children;
};
