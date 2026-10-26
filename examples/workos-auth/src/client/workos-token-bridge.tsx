import { useAuth } from "@workos-inc/authkit-react";
import type { LunoraClient } from "lunorash/client";
import type { ReactNode } from "react";
import { useEffect } from "react";

/**
 * Hand the AuthKit access token to Lunora, and keep it fresh.
 *
 * authkit-react keeps the access token in memory (the refresh token is an
 * HttpOnly cookie on the auth domain), so nothing reaches the API unless it is
 * sent as a bearer. `getAccessToken()` returns a valid token, refreshing it if
 * needed. When the server refuses an expired one (HTTP `TOKEN_EXPIRED`, socket
 * close 4001) `onTokenExpired` fires and the fresh token is handed over: HTTP
 * calls retry with it and sockets reconnect warm. Switching organization mints a
 * token with the new `org_id`, so it re-runs too.
 */
export const WorkOsTokenBridge = ({ children, client }: { children: ReactNode; client: LunoraClient }): ReactNode => {
    const { getAccessToken, isLoading, organizationId, user } = useAuth();
    const userId = user?.id;

    useEffect(() => {
        if (isLoading) {
            return undefined;
        }

        if (userId === undefined) {
            client.setAuthToken(null);

            return undefined;
        }

        let cancelled = false;

        const refresh = async (): Promise<void> => {
            const token = await getAccessToken();

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
    }, [client, getAccessToken, isLoading, organizationId, userId]);

    return children;
};
