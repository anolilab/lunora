/**
 * Worker-signed image delivery URLs (HMAC-SHA256).
 *
 * Same model as `@lunora/storage`'s `buildSignedUrl`: rather than a Cloudflare-
 * Images native signed-URL token (a self-contained bearer that reaches the
 * delivery edge directly), Lunora signs a URL that resolves back through your
 * own Worker route, so the request still passes your app's gates — auth/session,
 * per-image policy, rate limits, audit — before {@link verifySignedImageUrl}
 * validates the signature + expiry and the Worker serves the (optionally
 * transformed) image.
 *
 * Pure WebCrypto, no binding I/O → deterministic, safe to call from any handler.
 */

import type { TransformOptions } from "./types";

const textEncoder = new TextEncoder();

/** Upper bound on a signed-URL TTL — 7 days, matching `@lunora/storage` and common CDN ceilings. */
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

const SCHEME_PREFIX_RE = /^[a-z][a-z\d+\-.]*:\/\//i;
const LEADING_SLASH_RE = /^\//;

const toBase64Url = (bytes: Uint8Array): string => {
    // A SHA-256 HMAC is a fixed 32 bytes, well under the argument-spread limit,
    // so one `fromCodePoint` call is safe and cheaper than a per-byte loop.
    const binary = String.fromCodePoint(...bytes);

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (input: string): Uint8Array => {
    const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((input.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};

// The signing secret is effectively constant per process, so the imported
// (non-extractable) CryptoKey is memoized by secret value: this removes one
// `crypto.subtle.importKey` from the verify hot path on every request. Caching
// the Promise (not the resolved key) also coalesces concurrent imports.
//
// The cache is bounded to a small number of entries so a multi-tenant app that
// cycles through many per-tenant secrets doesn't accumulate unbounded memory.
// When the limit is reached the oldest entry is evicted (insertion-ordered Map
// iteration is FIFO). A maximum of 64 distinct secrets per isolate is well
// above any realistic single-tenant scenario, and isolates recycle anyway.
const KEY_CACHE_MAX = 64;
const keyCache = new Map<string, Promise<CryptoKey>>();

const importHmacKey = async (secret: string): Promise<CryptoKey> => {
    const cached = keyCache.get(secret);

    if (cached) {
        return cached;
    }

    // Evict the oldest entry when the cache is full.
    if (keyCache.size >= KEY_CACHE_MAX) {
        const oldest = keyCache.keys().next().value;

        if (oldest !== undefined) {
            keyCache.delete(oldest);
        }
    }

    const keyPromise = crypto.subtle.importKey("raw", textEncoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);

    keyCache.set(secret, keyPromise);

    return keyPromise;
};

// Stable, order-independent serialization of the transform so the same options
// canonicalize byte-for-byte regardless of key insertion order. Object-valued
// keys (e.g. gravity coordinates) are JSON-encoded; primitives stringify plainly.
const serializeTransform = (transform: TransformOptions | undefined): string => {
    if (transform === undefined) {
        return "";
    }

    return Object.entries(transform)
        .filter(([, value]) => value !== undefined)
        .toSorted(([a], [b]) => (a > b ? 1 : 0) - (a < b ? 1 : 0))
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        .join("&");
};

// Host is lowercased so a signature minted for `Example.com` verifies against
// `example.com` — DNS is case-insensitive, but the URL parser preserves case.
// The transform string is bound into the canonical so a client can't swap the
// requested transform (e.g. ask for a larger render) under the same signature.
const canonicalize = (host: string, key: string, exp: number, transform: string): string => `${host.toLowerCase()}\n${key}\n${String(exp)}\n${transform}`;

const extractHost = (input: string): string => {
    try {
        return new URL(input).host;
    } catch {
        const noScheme = input.replace(SCHEME_PREFIX_RE, "");

        return noScheme.split("/")[0] ?? "";
    }
};

const encodeKey = (key: string): string =>
    key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

export interface SignedImageUrlOptions {
    /** Delivery / Worker origin the signed URL points at (e.g. `https://cdn.acme.test`). */
    baseUrl: string;
    /** Seconds the URL stays valid. Default 3600; capped at 7 days. */
    expiresInSeconds?: number;
    /** Image key/id resolved by the Worker route (the pathname). */
    key: string;
    /** HMAC secret. MUST NOT be shared across tenants. */
    secret: string;

    /**
     * Transform requested by this URL. Bound into the signature, so a client
     * can't alter the render without invalidating it. The Worker should apply
     * exactly this (verified) transform via `ctx.images.transform(...)`.
     */
    transform?: TransformOptions;
}

/**
 * Mint a Worker-signed image URL: `baseUrl` joined to `key`, plus `exp` (unix
 * seconds), the serialized `t` (transform), and `sig` (base64url HMAC). The
 * canonical binds host + key + expiry + transform.
 *
 * The Worker handling the route should call {@link verifySignedImageUrl} to
 * validate before serving / transforming.
 */
export const buildSignedImageUrl = async (options: SignedImageUrlOptions): Promise<string> => {
    const expiresInSeconds = options.expiresInSeconds ?? 60 * 60;

    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
        throw new TypeError("@lunora/bindings/images: expiresInSeconds must be a positive finite number");
    }

    if (expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
        throw new TypeError(`@lunora/bindings/images: expiresInSeconds must not exceed ${String(MAX_EXPIRES_IN_SECONDS)} (7 days)`);
    }

    // A path on `baseUrl` would be prepended to the key in the minted URL's
    // pathname (`${base}/${safeKey}`), but `verifySignedImageUrl` reconstructs
    // the key from the ENTIRE `url.pathname` and can't know the base prefix — so
    // a base mounted at a subpath makes every minted URL fail verification. The
    // signature only binds host + key, not the base path, so we can't recover it
    // on verify; reject it loudly here instead of silently minting dead URLs.
    let basePath = "";

    try {
        basePath = new URL(options.baseUrl).pathname;
    } catch {
        // Non-absolute baseUrl (host-only form handled by `extractHost`): no path.
    }

    if (basePath !== "" && basePath !== "/") {
        throw new TypeError(
            `@lunora/bindings/images: baseUrl must not carry a path ("${basePath}") — the key is verified from the full URL pathname, so a subpath base would make every signed URL fail verification`,
        );
    }

    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const host = extractHost(options.baseUrl);
    const transform = serializeTransform(options.transform);
    // Normalize the key once and use the same form for both the canonical and
    // the URL path so signing and verification always agree, even when the
    // caller passes a key with a leading slash.
    const normalizedKey = options.key.replace(LEADING_SLASH_RE, "");
    const cryptoKey = await importHmacKey(options.secret);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(canonicalize(host, normalizedKey, exp, transform)));
    const sig = toBase64Url(new Uint8Array(signature));

    const base = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;
    const safeKey = encodeKey(normalizedKey);
    const tParameter = transform === "" ? "" : `&t=${encodeURIComponent(transform)}`;

    return `${base}/${safeKey}?exp=${String(exp)}&sig=${sig}${tParameter}`;
};

export interface VerifyImageResult {
    /** The verified image key (route pathname). */
    key?: string;

    /**
     * Internal-only failure reason for server logs/diagnostics. **Do not echo to
     * clients** — a precise reason ("expired" vs "bad_signature") is a signing
     * oracle. Public responses should expose only `valid`.
     */
    reason?: "bad_signature" | "expired" | "malformed";
    /** The raw, verified transform string (the `t` query value), when present. */
    transform?: string;
    valid: boolean;
}

/**
 * Verify a {@link buildSignedImageUrl} output. By default the signature is
 * canonicalized against the inbound `url.host`; pass `expectedHost` for a
 * CDN/host-rewrite topology where the Worker sees a different host than the one
 * the URL was minted for.
 */
export const verifySignedImageUrl = async (input: string | URL, secret: string, options?: { expectedHost?: string }): Promise<VerifyImageResult> => {
    let url: URL;

    try {
        url = input instanceof URL ? input : new URL(input);
    } catch {
        return { reason: "malformed", valid: false };
    }

    const expRaw = url.searchParams.get("exp");
    const exp = expRaw === null ? Number.NaN : Number(expRaw);
    const sig = url.searchParams.get("sig");
    const transform = url.searchParams.get("t") ?? "";

    if (!sig || !Number.isInteger(exp)) {
        return { reason: "malformed", valid: false };
    }

    if (exp < Math.floor(Date.now() / 1000)) {
        return { reason: "expired", valid: false };
    }

    let key: string;
    let sigBytes: Uint8Array;

    try {
        key = url.pathname
            .replace(LEADING_SLASH_RE, "")
            .split("/")
            .map((segment) => decodeURIComponent(segment))
            .join("/");
        sigBytes = fromBase64Url(sig);
    } catch {
        return { reason: "malformed", valid: false };
    }

    const host = options?.expectedHost === undefined ? url.host : extractHost(options.expectedHost);
    const cryptoKey = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
        "HMAC",
        cryptoKey,
        sigBytes as unknown as BufferSource,
        textEncoder.encode(canonicalize(host, key, exp, transform)),
    );

    if (!valid) {
        return { reason: "bad_signature", valid: false };
    }

    return { key, transform: transform === "" ? undefined : transform, valid: true };
};
