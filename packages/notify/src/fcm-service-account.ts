import { fromBase64, toBase64Url } from "../../../shared/base64";
import { evictOldestEntry } from "../../../shared/evict-oldest";

/**
 * The fields of a Google service-account key file that FCM HTTP v1 needs. The
 * file is what `gcloud iam service-accounts keys create` and the Firebase console
 * download; its other fields are ignored.
 */
interface FcmServiceAccount {
    client_email: string;
    private_key: string;
    project_id?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Google accepts assertions valid for up to an hour; the access token lasts as long. */
const ASSERTION_TTL_SECONDS = 3600;

/** Refresh this long before the token expires, so a send never starts with a stale one. */
const REFRESH_MARGIN_MS = 60_000;

/** Bounds the token exchange, so one stalled request cannot hold every FCM send queued behind it. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** Service accounts whose access token one isolate keeps. Bounded like the other per-isolate memos. */
const TOKEN_CACHE_CAPACITY = 16;

interface CachedToken {
    /** `Infinity` while the exchange is in flight, so concurrent sends join it instead of minting again. */
    expiresAt: number;
    token: Promise<string>;
}

/**
 * Keyed by the raw key-file secret, not by `client_email`: a rotated key under the same
 * email must not keep serving a token minted from the old key. Kept at module scope,
 * because `defineNotify`'s `fcm` factory re-runs on every RPC and a cache built inside it
 * would be rebuilt per request, minting a token on every send.
 */
const tokenCache = new Map<string, CachedToken>();

interface FcmServiceAccountTokenOptions {
    /** Injected for tests; defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Injected for tests; defaults to `Date.now`. */
    now?: () => number;
}

/**
 * The key file as JSON text. `.dev.vars` cannot hold a `"` or a backslash, so the secret may also be
 * the key file base64-encoded; anything not starting with `{` is decoded as base64 first.
 */
const decodeServiceAccountText = (raw: string): string => {
    const trimmed = raw.trim();

    return trimmed.startsWith("{") ? trimmed : new TextDecoder().decode(fromBase64(trimmed));
};

/**
 * Parse the key file held in an env secret, given as JSON or as base64 of that JSON.
 * Throws on a malformed key rather than returning `undefined`, so the failure is
 * visible on the first FCM send.
 *
 * A PEM pasted into a `.dev.vars` file usually has its newlines escaped as the two
 * characters `\n`; they are restored here so either form works.
 */
const parseServiceAccount = (raw: string): FcmServiceAccount => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(decodeServiceAccountText(raw));
    } catch {
        // No `cause`: V8's JSON and base64 errors can quote a fragment of the input, and the input is key material.
        throw new TypeError("FCM_SERVICE_ACCOUNT is neither valid JSON nor base64-encoded JSON (use the service-account key file as-is, or base64 of it)");
    }

    const candidate = parsed as Partial<FcmServiceAccount> | null;

    if (typeof candidate?.client_email !== "string" || typeof candidate.private_key !== "string") {
        throw new TypeError("FCM_SERVICE_ACCOUNT must contain client_email and private_key");
    }

    return {
        client_email: candidate.client_email,
        private_key: candidate.private_key.replaceAll(String.raw`\n`, "\n"),
        // An empty id would reach `createFcmProvider`, which throws on it while the engine is built and takes every channel down.
        project_id: typeof candidate.project_id === "string" && candidate.project_id !== "" ? candidate.project_id : undefined,
    };
};

/** Import a PKCS#8 PEM private key for RS256 signing. The PEM armour lines and whitespace are stripped first. */
const importSigningKey = (pem: string): Promise<CryptoKey> => {
    const der = fromBase64(pem.replaceAll(/-----[^-]+-----|\s/g, ""));

    return crypto.subtle.importKey("pkcs8", der, { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" }, false, ["sign"]);
};

/**
 * A compact JWS signed RS256, the assertion format Google's token endpoint accepts.
 * Hand-rolled rather than `jose`: notify takes no new dependency for one RS256 signature,
 * and Web Crypto is native on workerd.
 */
const signAssertion = async (claims: Record<string, unknown>, key: CryptoKey): Promise<string> => {
    const encoder = new TextEncoder();
    const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`));

    return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
};

/**
 * Exchange a service-account key for an FCM access token: sign a JWT assertion
 * with the key (RS256, via Web Crypto), then trade it at Google's token endpoint.
 */
const exchange = async (account: FcmServiceAccount, fetchImpl: typeof fetch, now: () => number): Promise<{ expiresAt: number; token: string }> => {
    const key = await importSigningKey(account.private_key);
    const issuedAt = Math.floor(now() / 1000);
    const assertion = await signAssertion(
        {
            aud: TOKEN_URL,
            exp: issuedAt + ASSERTION_TTL_SECONDS,
            iat: issuedAt,
            iss: account.client_email,
            scope: FCM_SCOPE,
        },
        key,
    );

    const response = await fetchImpl(TOKEN_URL, {
        body: new URLSearchParams({ assertion, grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`Google token exchange failed with HTTP ${String(response.status)}`);
    }

    const body: { access_token?: unknown; expires_in?: unknown } = await response.json();

    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
        throw new TypeError("Google token exchange returned no access_token");
    }

    return { expiresAt: now() + body.expires_in * 1000 - REFRESH_MARGIN_MS, token: body.access_token };
};

/**
 * An edge-safe `getAccessToken` for `createFcmProvider`, minted from the key-file secret
 * and cached until shortly before it expires. The key is parsed on the first send that
 * needs a token, not when the config is built, so a bad secret fails FCM sends only.
 *
 * A failed exchange is removed from the cache, so the next send retries it: an
 * outage at Google must not pin a rejected promise for the isolate's life.
 */
const fcmServiceAccountTokenSource = (rawServiceAccount: string, options: FcmServiceAccountTokenOptions = {}): (() => Promise<string>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;

    return () => {
        const cached = tokenCache.get(rawServiceAccount);

        if (cached !== undefined && cached.expiresAt > now()) {
            return cached.token;
        }

        if (cached === undefined) {
            evictOldestEntry(tokenCache, TOKEN_CACHE_CAPACITY);
        }

        // `async` so a malformed key rejects the promise the cache holds, and the failure cleanup below runs.
        const mint = async (): Promise<{ expiresAt: number; token: string }> => exchange(parseServiceAccount(rawServiceAccount), fetchImpl, now);

        const entry: CachedToken = {
            expiresAt: Number.POSITIVE_INFINITY,
            token: mint().then(
                (minted) => {
                    entry.expiresAt = minted.expiresAt;

                    return minted.token;
                },
                (error: unknown) => {
                    if (tokenCache.get(rawServiceAccount) === entry) {
                        tokenCache.delete(rawServiceAccount);
                    }

                    throw error;
                },
            ),
        };

        tokenCache.set(rawServiceAccount, entry);

        return entry.token;
    };
};

export { fcmServiceAccountTokenSource, parseServiceAccount };
