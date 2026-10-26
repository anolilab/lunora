import { useAuth } from "@clerk/react";
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
 * Hand Clerk's session token to Lunora, and keep it fresh.
 *
 * Clerk session tokens live 60 s. The bridge fetches a fresh one shortly
 * before each expires; with `authTokenOnUpgrade` that also reconnects the
 * live-query sockets warm, resuming from their cursors. `onTokenExpired`
 * covers the cases the timer misses — a socket the server closed with 4001,
 * or an offline write replayed with a lapsed token. Switching organization
 * mints a token with the new `o` claim, so the effect re-runs on it too.
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
        let timer: ReturnType<typeof setTimeout> | undefined;

        const refresh = async (): Promise<void> => {
            clearTimeout(timer);

            const token = await getToken();

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
    }, [client, getToken, isLoaded, isSignedIn, orgId, userId]);

    return children;
};
