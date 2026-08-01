/**
 * Worker-signed object URLs (HMAC-SHA256).
 *
 * Why not R2's native S3 presigned URLs? A presigned URL is a self-contained
 * bearer credential: anyone holding it reaches the object directly on R2's S3
 * endpoint, bypassing the Worker. Lunora signs URLs that resolve back through
 * your own Worker (`publicBaseUrl` → `GET /storage/:key`), so the request still
 * passes your app's gates — auth/session checks, per-object policy, rate limits,
 * audit — before {@link verifySignedUrl} validates the signature + expiry and
 * the Worker streams the R2 body. App-gating is the point; the trade-off is the
 * object bytes flow through the Worker rather than straight off R2.
 *
 * Reach for native S3 presigned URLs instead when you want clients to hit R2
 * directly (large downloads, no per-request app logic) — see `buildPresignedUrl`
 * / `Storage.getPresignedUrl`. For very large objects, `Storage.createMultipartUpload`
 * wraps R2's native multipart API.
 */
import { LunoraError } from "@lunora/errors";

import { assertCanonicalSafe, extractHost, fromBase64Url, MAX_SIGNED_URL_TTL_SECONDS, signCanonical, verifyCanonical } from "../../../shared/hmac-url";
import { trimTrailingSlashes } from "./internal";
import type { SignedUrlOptions } from "./types";

// Hoisted to module scope so the literal isn't recompiled on every call. The
// base64url codec, bounded key cache, host extraction, and sign/verify live in
// `shared/hmac-url.ts` (shared byte-for-byte with `@lunora/bindings` images).
const LEADING_SLASH_RE = /^\//;

// Host is lowercased so a signature minted for `Example.com` verifies against
// `example.com` — DNS is case-insensitive, but the URL parser preserves case.
//
// `contentType` (a PUT-only pin) is appended as a fifth line only when present,
// so a plain GET/PUT signature canonicalizes byte-for-byte the way it always
// has — existing URLs (no `ct`) keep verifying. When present, the uploader's
// request `Content-Type` is bound into the signature.
const canonicalize = (method: "GET" | "PUT", host: string, key: string, exp: number, contentType?: string): string => {
    const base = `${method}\n${host.toLowerCase()}\n${key}\n${String(exp)}`;

    return contentType === undefined ? base : `${base}\n${contentType}`;
};

/**
 * Worker-signed URL: the `publicBaseUrl` joined to the object `key`, plus a query
 * string carrying `exp` (unix seconds), `method` (`GET` or `PUT`) and `sig`
 * (a base64url HMAC).
 *
 * The HMAC canonical includes the URL host so a signature minted for one bucket
 * cannot be replayed against another host on the same signing secret. Even so,
 * the signing secret MUST NOT be shared across buckets/tenants — host binding
 * narrows replay surface but is not a substitute for per-tenant key isolation.
 *
 * The Worker handling `GET /storage/:key` should call {@link verifySignedUrl}
 * to validate the signature + expiry before streaming the R2 body.
 */
export const buildSignedUrl = async (
    args: SignedUrlOptions & {
        baseUrl: string;
        key: string;
        secret: string;
    },
): Promise<string> => {
    const method = args.method ?? "GET";
    const expiresInSeconds = args.expiresInSeconds ?? 60 * 60;

    // Fail fast on a non-positive/non-finite TTL (which would mint an
    // already-expired URL that verify silently rejects) and enforce a ceiling
    // so a bogus value can't mint an effectively non-expiring URL.
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: expiresInSeconds must be a positive finite number");
    }

    if (expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: expiresInSeconds must not exceed ${String(MAX_SIGNED_URL_TTL_SECONDS)} (7 days)`);
    }

    // contentType is a PUT-only pin: a GET URL has no request body to constrain,
    // so drop it for GET to keep GET canonicals unchanged.
    const contentType = method === "PUT" ? args.contentType : undefined;

    // The canonical is newline-delimited and `key` is not its last field, so a
    // key containing a raw CR/LF could shift `exp` (and `contentType`) on
    // re-split — reject it here rather than minting a URL two different keys
    // could both satisfy. See `shared/hmac-url.ts#assertCanonicalSafe`.
    assertCanonicalSafe(args.key);

    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const host = extractHost(args.baseUrl);
    const sig = await signCanonical(args.secret, canonicalize(method, host, args.key, exp, contentType));

    const base = trimTrailingSlashes(args.baseUrl);
    const safeKey = args.key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    const ctParameter = contentType === undefined ? "" : `&ct=${encodeURIComponent(contentType)}`;

    return `${base}/${safeKey}?exp=${String(exp)}&method=${method}&sig=${sig}${ctParameter}`;
};

export interface VerifyResult {
    /** The pinned upload `Content-Type` carried by a PUT URL, when present. */
    contentType?: string;
    key?: string;
    method?: "GET" | "PUT";

    /**
     * Internal-only failure reason for server logs/diagnostics. **Do not echo
     * to clients** — a precise reason ("expired" vs "bad_signature") is a
     * signing oracle. Public responses should expose only `valid`.
     */
    reason?: "bad_signature" | "expired" | "malformed";
    valid: boolean;
}

/**
 * Verify a {@link buildSignedUrl} output. By default the signature is
 * canonicalized against the inbound `url.host`, which matches the build-side
 * host whenever the URL being verified is the URL that was minted. In a
 * topology where the host the Worker sees differs from the configured
 * `publicBaseUrl` host (e.g. a CDN host vs a Worker route that rewrites
 * `Host`), pass `expectedHost` (the `publicBaseUrl` host) so verification
 * canonicalizes against the same host the signature was minted for instead of
 * failing every request as `bad_signature`.
 */
export const verifySignedUrl = async (input: string | URL, secret: string, options?: { expectedHost?: string }): Promise<VerifyResult> => {
    let url: URL;

    try {
        url = input instanceof URL ? input : new URL(input);
    } catch {
        return { reason: "malformed", valid: false };
    }

    // Strict integer parse: `Number.parseInt` would accept trailing garbage
    // ("123abc" -> 123). buildSignedUrl only ever emits a clean integer, so a
    // non-integer `exp` is tampered/malformed.
    const expRaw = url.searchParams.get("exp");
    const exp = expRaw === null ? Number.NaN : Number(expRaw);
    const sig = url.searchParams.get("sig");
    // Keep `method` as a plain string so the GET/PUT guard below stays a real
    // runtime check (a `as "GET" | "PUT"` cast would make the linter — and the
    // type system — treat the guard as dead code).
    const method = url.searchParams.get("method") ?? "GET";
    // A PUT-only content-type pin. Absent → undefined, which canonicalizes the
    // legacy (no-`ct`) form so old URLs keep verifying.
    const contentType = url.searchParams.get("ct") ?? undefined;

    if (!sig || !Number.isInteger(exp)) {
        return { reason: "malformed", valid: false };
    }

    if (exp < Math.floor(Date.now() / 1000)) {
        return { reason: "expired", valid: false };
    }

    if (method !== "GET" && method !== "PUT") {
        return { reason: "malformed", valid: false };
    }

    // Pathname is `/<key>`. Strip the leading slash and decode each segment.
    // A malformed percent-escape (decodeURIComponent) or a non-base64url `sig`
    // (atob) throws — treat either as `malformed` rather than letting it
    // propagate as an uncaught rejection.
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

    // Canonicalize against an explicit expected host when supplied (CDN/host-
    // rewrite topologies); otherwise bind to the inbound host, which equals the
    // build-side host whenever the verified URL is the minted URL.
    const host = options?.expectedHost === undefined ? url.host : extractHost(options.expectedHost);
    const valid = await verifyCanonical(secret, canonicalize(method, host, key, exp, contentType), sigBytes);

    if (!valid) {
        return { reason: "bad_signature", valid: false };
    }

    return { contentType, key, method, valid: true };
};
