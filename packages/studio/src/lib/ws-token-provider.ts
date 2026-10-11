/**
 * Ephemeral WS admin-token provider. A browser
 * `WebSocket` can't set an `Authorization` header, so the studio's live admin
 * subscriptions must send their credential in the `?token=` query string —
 * which lands in access logs and browser history. Instead of putting the
 * master admin token there, this provider mints a short-lived HMAC-signed
 * sub-token from the worker (`POST /_lunora/admin/ws-token`, authenticated by
 * the master token in the HEADER) and hands it to the client as its
 * `wsToken` provider, re-minting on every (re)connect.
 *
 * Caching: the minted `{ token, expiresAtMs }` is reused until ~10s before
 * expiry (so a reconnect burst doesn't hammer the mint endpoint), and
 * concurrent mints coalesce onto one in-flight request. `invalidate()` drops
 * the cache — wire it to `client.onTokenExpired` so a `4001` close re-mints
 * immediately even when the cached token looks fresh (e.g. the master token
 * was rotated, which invalidates every outstanding sub-token).
 *
 * The master token is never a WS credential. A mint failure of any kind,
 * including a 404 or 405 from a worker without the mint route, throws, which
 * the client surfaces as a failed connect attempt and retries with its
 * reconnect backoff. A worker without the mint endpoint cannot be used with
 * the studio.
 */

/** Path of the worker's admin WS-token mint endpoint. */
const WS_TOKEN_MINT_PATH = "/_lunora/admin/ws-token";

/** Re-mint this many ms before the token's expiry, so a fresh connect never rides an about-to-lapse token. */
const REFRESH_MARGIN_MS = 10_000;

interface MintedWsToken {
    expiresAtMs: number;
    token: string;
}

interface AdminWsTokenProviderOptions {
    /** The master admin token — authenticates the mint request (header bearer). It is never sent as a WS credential. */
    readonly adminToken: string;
    /** Origin of the Lunora worker (no trailing slash needed). */
    readonly baseUrl: string;
    /** Injectable fetch for tests; defaults to the global. */
    readonly fetchImpl?: typeof fetch;
}

interface AdminWsTokenProvider {
    /** Resolve the WS credential: a cached-or-fresh ephemeral sub-token. Pass as the client's `wsToken`. */
    readonly getToken: () => Promise<string>;
    /** Drop the cached token so the next `getToken` re-mints. Wire to `client.onTokenExpired`. */
    readonly invalidate: () => void;
}

/** Narrow an unknown mint-response body to {@link MintedWsToken}. */
const isMintedWsToken = (body: unknown): body is MintedWsToken => {
    const candidate = body as { expiresAtMs?: unknown; token?: unknown } | null | undefined;

    return typeof candidate?.token === "string" && candidate.token.length > 0 && typeof candidate.expiresAtMs === "number";
};

/** Create the studio's ephemeral WS admin-token provider. See the module docs for the caching / fallback contract. */
export const createAdminWsTokenProvider = (options: AdminWsTokenProviderOptions): AdminWsTokenProvider => {
    const { adminToken, baseUrl } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    let origin = baseUrl;

    while (origin.endsWith("/")) {
        origin = origin.slice(0, -1);
    }

    const mintUrl = `${origin}${WS_TOKEN_MINT_PATH}`;

    let cached: MintedWsToken | undefined;
    let inFlight: Promise<string> | undefined;

    const mint = async (): Promise<string> => {
        const response = await fetchImpl(mintUrl, {
            headers: { authorization: `Bearer ${adminToken}` },
            method: "POST",
        });

        // Any failure leaves no sub-token to hand out, and the master token must never
        // stand in for one: it would ride the `?token=` query string into access logs
        // and browser history.
        if (!response.ok) {
            throw new Error(`ws-token mint failed: ${String(response.status)}`);
        }

        const body: unknown = await response.json().catch(() => undefined);

        if (!isMintedWsToken(body)) {
            throw new Error("ws-token mint failed: malformed response body");
        }

        cached = body;

        return body.token;
    };

    return {
        getToken: async (): Promise<string> => {
            if (cached !== undefined && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) {
                return cached.token;
            }

            // Coalesce concurrent resolutions (several shard sockets reconnecting
            // at once) onto a single mint request.
            inFlight ??= mint().finally(() => {
                inFlight = undefined;
            });

            return inFlight;
        },
        invalidate: (): void => {
            cached = undefined;
        },
    };
};

export type { AdminWsTokenProvider, AdminWsTokenProviderOptions };
