import { fromBase64Url } from "../../../shared/base64";
import type { LunoraClient } from "./lunora-client";
import type { Unsubscribe } from "./types";

/** Refresh this long before the token's `exp`, so no call goes out with a lapsed token. */
const REFRESH_LEAD_MS = 10_000;

/** Never refresh more often than this, whatever the token says. */
const MIN_REFRESH_MS = 5000;

/** Retry delay after `fetchToken` threw (a network blip, a provider outage). */
const RETRY_MS = 5000;

interface AuthTokenProviderOptions {
    /**
     * The stable user id behind the token, passed as `setAuthToken`'s `subject`
     * so a refreshed token is not mistaken for an account switch (which would
     * reject the queued offline writes `OFFLINE_IDENTITY_CHANGED`).
     */
    subject?: string | null;
}

/** A provider token's fetcher: the current token, or `null` once the user is signed out. */
type AuthTokenFetcher = () => Promise<string | null>;

/** The token's `exp` in epoch milliseconds, read for timing only (the worker verifies it), or `undefined`. */
const expiresAtMs = (token: string): number | undefined => {
    try {
        const payload: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(token.split(".")[1] ?? "")));
        const exp = typeof payload === "object" && payload !== null ? (payload as { exp?: unknown }).exp : undefined;

        return typeof exp === "number" ? exp * 1000 : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Keep the client's bearer in sync with an external identity provider (Clerk,
 * WorkOS, Auth0…): fetch a token now, install it with `setAuthToken(token,
 * subject)`, and fetch the next one shortly before the current one's `exp`.
 * `onTokenExpired` (a socket closed `4001`, a refused offline replay) triggers
 * an immediate refresh too.
 *
 * - One timer chain: a refresh in flight is shared, and each refresh replaces
 * the pending timer.
 * - `fetchToken` resolving `null` means signed out: the token is cleared and
 * no refresh is scheduled. Map the provider's "not signed in" error to `null`
 * (WorkOS `LoginRequiredError`; Clerk's `getToken()` already resolves `null`).
 * - Any other error keeps the current token and retries after 5 s.
 *
 * Returns a stop function; call it on unmount or before installing another
 * provider.
 *
 * ```ts
 * const stop = setAuthTokenProvider(client, () => getToken(), { subject: userId });
 * ```
 */
const setAuthTokenProvider = (client: LunoraClient, fetchToken: AuthTokenFetcher, options: AuthTokenProviderOptions = {}): Unsubscribe => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<number | undefined> | undefined;

    /** Fetch and install a token; resolves to the delay before the next refresh, or `undefined` for none. */
    const run = async (): Promise<number | undefined> => {
        let token: string | null;

        try {
            token = await fetchToken();
        } catch {
            return RETRY_MS;
        }

        if (stopped) {
            return undefined;
        }

        client.setAuthToken(token, token === null ? undefined : options.subject);

        const expiresAt = token === null ? undefined : expiresAtMs(token);

        return expiresAt === undefined ? undefined : Math.max(MIN_REFRESH_MS, expiresAt - Date.now() - REFRESH_LEAD_MS);
    };

    /** A refresh while one is in flight joins it: that one schedules the next, so there is only ever one timer chain. */
    const refresh = async (): Promise<void> => {
        if (inFlight !== undefined) {
            return;
        }

        clearTimeout(timer);
        inFlight = run();

        let delayMs: number | undefined;

        try {
            delayMs = await inFlight;
        } finally {
            inFlight = undefined;
        }

        if (delayMs !== undefined && !stopped) {
            timer = setTimeout(() => {
                refresh().catch(() => undefined);
            }, delayMs);
        }
    };

    const unsubscribe = client.onTokenExpired(() => {
        refresh().catch(() => undefined);
    });

    refresh().catch(() => undefined);

    return () => {
        stopped = true;
        clearTimeout(timer);
        unsubscribe();
    };
};

export type { AuthTokenFetcher, AuthTokenProviderOptions };
export { setAuthTokenProvider };
