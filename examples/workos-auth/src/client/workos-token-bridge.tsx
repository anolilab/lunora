import { LoginRequiredError, useAuth } from "@workos-inc/authkit-react";
import type { LunoraClient } from "lunorash/client";
import { setAuthTokenProvider } from "lunorash/client";
import type { ReactNode } from "react";
import { useEffect } from "react";

/**
 * Hand the AuthKit access token to Lunora, and keep it fresh.
 *
 * The access token reaches the API only as a bearer. `getAccessToken()`
 * returns a valid token, refreshing it if needed; `setAuthTokenProvider` asks
 * for one shortly before each expires (with `authTokenOnUpgrade` that also
 * reconnects the live-query sockets warm) and on `onTokenExpired`.
 * `getAccessToken()` throws `LoginRequiredError` once the session is gone,
 * which is mapped to `null` (signed out). Switching organization mints a token
 * with the new `org_id`, so the effect re-runs too.
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

        const fetchToken = async (): Promise<string | null> => {
            try {
                return await getAccessToken();
            } catch (error) {
                if (error instanceof LoginRequiredError) {
                    return null;
                }

                throw error;
            }
        };

        return setAuthTokenProvider(client, fetchToken, { subject: userId });
    }, [client, getAccessToken, isLoading, organizationId, userId]);

    return children;
};
