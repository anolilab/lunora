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

import { assertCanonicalSafe, extractHost, fromBase64Url, MAX_SIGNED_URL_TTL_SECONDS, signCanonical, verifyCanonical } from "../../../../shared/hmac-url";
import type { TransformOptions } from "./types";

// Hoisted to module scope so the literal isn't recompiled on every call. The
// base64url codec, bounded key cache, host extraction, and sign/verify live in
// `shared/hmac-url.ts` (shared byte-for-byte with `@lunora/storage`).
const LEADING_SLASH_RE = /^\//;

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

    if (expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
        throw new TypeError(`@lunora/bindings/images: expiresInSeconds must not exceed ${String(MAX_SIGNED_URL_TTL_SECONDS)} (7 days)`);
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

    // The canonical is newline-delimited and `key` is not its last field, so a
    // key containing a raw CR/LF could shift `exp` (and `transform`) on
    // re-split — reject it here rather than minting a URL two different keys
    // could both satisfy. See `shared/hmac-url.ts#assertCanonicalSafe`.
    assertCanonicalSafe(normalizedKey);

    const sig = await signCanonical(options.secret, canonicalize(host, normalizedKey, exp, transform));

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
        // A percent-decoded key carrying a raw CR/LF is rejected the same as a
        // decode failure — see the build-side comment on `assertCanonicalSafe`.
        assertCanonicalSafe(key);
        sigBytes = fromBase64Url(sig);
    } catch {
        return { reason: "malformed", valid: false };
    }

    const host = options?.expectedHost === undefined ? url.host : extractHost(options.expectedHost);
    const valid = await verifyCanonical(secret, canonicalize(host, key, exp, transform), sigBytes);

    if (!valid) {
        return { reason: "bad_signature", valid: false };
    }

    return { key, transform: transform === "" ? undefined : transform, valid: true };
};
