import { useAuth } from "@workos-inc/authkit-react";
import type { LunoraClient } from "lunorash/client";
import type { ReactNode } from "react";
import { useEffect } from "react";

/**
 * When to refresh: ten seconds before the token's `exp`, so a call never goes
 * out with a lapsed token (the server would refuse it `TOKEN_EXPIRED`). The
 * payload is only read for timing here; the worker is what verifies it.
 */
const refreshDelayMs = (token: string | null): number => {
    try {
        const payload = token?.split(".")[1] ?? "";
        const { exp } = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { exp?: unknown };

        return typeof exp === "number" ? Math.max(5000, exp * 1000 - Date.now() - 10_000) : 50_000;
    } catch {
        return 50_000;
    }
};

/**
 * Hand the AuthKit access token to Lunora, and keep it fresh.
 *
 * authkit-react keeps the access token in memory (the refresh token is an
 * HttpOnly cookie on the auth domain), so nothing reaches the API unless it is
 * sent as a bearer. `getAccessToken()` returns a valid token, refreshing it if
 * needed; the bridge asks for one shortly before each expires, and with
 * `authTokenOnUpgrade` that also reconnects the live-query sockets warm.
 * `onTokenExpired` covers what the timer misses — a socket the server closed
 * with 4001, or an offline write replayed with a lapsed token. Switching
 * organization mints a token with the new `org_id`, so the effect re-runs too.
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
        let timer: ReturnType<typeof setTimeout> | undefined;

        const refresh = async (): Promise<void> => {
            clearTimeout(timer);

            const token = await getAccessToken();

            if (!cancelled) {
                client.setAuthToken(token, userId);
                timer = setTimeout(() => {
                    void refresh();
                }, refreshDelayMs(token));
            }
        };

        void refresh();

        const unsubscribe = client.onTokenExpired(() => {
            void refresh();
        });

        return () => {
            cancelled = true;
            clearTimeout(timer);
            unsubscribe();
        };
    }, [client, getAccessToken, isLoading, organizationId, userId]);

    return children;
};
