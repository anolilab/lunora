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
 * Compatibility: a worker predating the mint endpoint answers 404 (or 405);
 * the provider then falls back to the master token — the pre-095 behavior —
 * and remembers the miss so it doesn't re-probe on every reconnect. Any other
 * mint failure (network error, 403, 5xx) throws, which the client surfaces as
 * a failed connect attempt and retries with its reconnect backoff. `invalidate()`
 * clears that memory along with the cache — a 404 from a proxy or a BYO dev
 * server is not proof the endpoint is gone forever, and the rotation-recovery
 * path is exactly where re-probing is worth one request.
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
    /** The master admin token — authenticates the mint request (header bearer) and is the 404 fallback credential. */
    readonly adminToken: string;
    /** Origin of the Lunora worker (no trailing slash needed). */
    readonly baseUrl: string;
    /** Injectable fetch for tests; defaults to the global. */
    readonly fetchImpl?: typeof fetch;
}

interface AdminWsTokenProvider {
    /** Resolve the WS credential: a cached-or-fresh ephemeral token, or the master token on an old worker. Pass as the client's `wsToken`. */
    readonly getToken: () => Promise<string>;
    /** Drop the cached token — and the "endpoint is missing" memory — so the next `getToken` re-mints. Wire to `client.onTokenExpired`. */
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
    let endpointMissing = false;
    let inFlight: Promise<string> | undefined;

    const mint = async (): Promise<string> => {
        const response = await fetchImpl(mintUrl, {
            headers: { authorization: `Bearer ${adminToken}` },
            method: "POST",
        });

        // A pre-095 worker has no mint route: fall back to the master token
        // (the old behavior) and remember the miss so reconnects don't re-probe.
        if (response.status === 404 || response.status === 405) {
            endpointMissing = true;

            return adminToken;
        }

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
            if (endpointMissing) {
                return adminToken;
            }

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

            // Clear the 404 latch too. It is a "don't re-probe on every reconnect"
            // optimisation, not a permanent verdict: one 404 is reachable without a
            // legacy worker (a proxy/CDN answering an unknown POST, a BYO dev setup
            // where Vite serves the mint path), and this is the rotation-recovery
            // path (`client.onTokenExpired`) — the one moment we already know the
            // credential picture changed. Leaving it set pinned the WS credential to
            // the MASTER admin token for the provider's whole life, putting it in
            // the `?token=` query string — access logs, browser history — that this
            // module exists to keep it out of.
            endpointMissing = false;
        },
    };
};

export type { AdminWsTokenProvider, AdminWsTokenProviderOptions };
