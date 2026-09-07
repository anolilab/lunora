/**
 * Worker-signed object URLs (HMAC-SHA256).
 *
 * Why not R2's native S3 presigned URLs? A presigned URL is a self-contained
 * bearer credential: anyone holding it reaches the object directly on R2's S3
 * endpoint, bypassing the Worker. Lunora signs URLs that resolve back through
 * your own Worker (`publicBaseUrl` at the Worker's own origin, e.g.
 * `GET /:key` on a dedicated hostname), so the request still passes your app's
 * gates — auth/session checks, per-object policy, rate limits, audit — before
 * {@link verifySignedUrl} validates the signature + expiry and the Worker
 * streams the R2 body. App-gating is the point; the trade-off is the object
 * bytes flow through the Worker rather than straight off R2.
 *
 * `publicBaseUrl` must NOT carry a path (a bare origin, optionally with a
 * trailing slash) — {@link buildSignedUrl} rejects a subpath base, because the
 * signature binds host + bucket + key and {@link verifySignedUrl} reconstructs
 * the key from the full URL pathname, so a subpath base would make every minted
 * URL fail verification.
 *
 * Reach for native S3 presigned URLs instead when you want clients to hit R2
 * directly (large downloads, no per-request app logic) — see `buildPresignedUrl`
 * / `Storage.getPresignedUrl`. For very large objects, `Storage.createMultipartUpload`
 * wraps R2's native multipart API.
 */
import { LunoraError } from "@lunora/errors";

import {
    assertCanonicalSafe,
    extractHost,
    fromBase64Url,
    isOnlySlashesPath,
    MAX_SIGNED_URL_TTL_SECONDS,
    signCanonical,
    validateTtlSeconds,
    verifyCanonical,
} from "../../../shared/hmac-url";
import { trimTrailingSlashes } from "./internal";
import type { SignedUrlOptions } from "./types";

// Hoisted to module scope so the literal isn't recompiled on every call. The
// base64url codec, bounded key cache, host extraction, sign/verify, and the
// TTL/base-path validators live in `shared/hmac-url.ts` (shared byte-for-byte
// with `@lunora/bindings` images).
const LEADING_SLASH_RE = /^\//;

// Host is lowercased so a signature minted for `Example.com` verifies against
// `example.com` — DNS is case-insensitive, but the URL parser preserves case.
//
// `bucketName` is bound as its own line: every bucket in a `.storage({ bucket,
// buckets })` declaration shares one `publicBaseUrl` + `signingSecret`, so
// without it a URL minted for a bucket the caller IS allowed on is byte-identical
// to one for a bucket it is not — and the serving route has nothing to select a
// bucket from. It is mirrored on the URL as `&bucket=...` so verify can rebuild
// the same canonical and tell the route which bucket to serve.
//
// `contentType` (a PUT-only pin) is appended as a last line only when present.
// When present, the uploader's request `Content-Type` is bound into the signature.
const canonicalize = (method: "GET" | "PUT", host: string, bucketName: string, key: string, exp: number, contentType?: string): string => {
    const base = `${method}\n${host.toLowerCase()}\n${bucketName}\n${key}\n${String(exp)}`;

    return contentType === undefined ? base : `${base}\n${contentType}`;
};

/**
 * Worker-signed URL: the `publicBaseUrl` joined to the object `key`, plus a query
 * string carrying `exp` (unix seconds), `method` (`GET` or `PUT`) and `sig`
 * (a base64url HMAC).
 *
 * The HMAC canonical includes the URL host AND the `bucketName`, so a signature
 * minted for one bucket cannot be replayed against another bucket (all buckets
 * of one `.storage()` declaration share a base URL and signing secret) or
 * another host. Even so, the signing secret MUST NOT be shared across
 * tenants — this binding narrows replay surface but is not a substitute for
 * per-tenant key isolation.
 *
 * The Worker route handling the signed download/upload (mounted at
 * `publicBaseUrl`'s origin, e.g. `GET /:key`) should call
 * {@link verifySignedUrl} to validate the signature + expiry before streaming
 * the R2 body. `baseUrl` must be a bare origin (no path) — see the module
 * docstring.
 */
export const buildSignedUrl = async (
    args: {
        baseUrl: string;
        /** The bucket the URL addresses — bound into the HMAC and mirrored as `&bucket=`. */
        bucketName: string;
        key: string;
        secret: string;
    } & SignedUrlOptions,
): Promise<string> => {
    const method = args.method ?? "GET";
    const expiresInSeconds = args.expiresInSeconds ?? 60 * 60;

    // Fail fast on a non-positive/non-finite TTL (which would mint an
    // already-expired URL that verify silently rejects) and enforce a ceiling
    // so a bogus value can't mint an effectively non-expiring URL.
    const ttlProblem = validateTtlSeconds(expiresInSeconds, MAX_SIGNED_URL_TTL_SECONDS);

    if (ttlProblem !== undefined) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: ${ttlProblem}`);
    }

    // contentType is a PUT-only pin: a GET URL has no request body to constrain,
    // so drop it for GET to keep GET canonicals unchanged.
    const contentType = method === "PUT" ? args.contentType : undefined;

    // A path on `baseUrl` would be prepended to the key in the minted URL's
    // pathname (`${base}/${safeKey}`), but `verifySignedUrl` reconstructs the
    // key from the ENTIRE `url.pathname` and can't know the base prefix — so a
    // base mounted at a subpath makes every minted URL fail verification. The
    // signature binds host + bucket + key, not the base path, so we can't
    // recover it on verify; reject it loudly instead of minting dead URLs.
    // A pathname of only slashes is fine — `trimTrailingSlashes` collapses it to
    // the bare origin (see `isOnlySlashesPath` in `shared/hmac-url.ts`).
    let basePath = "";

    try {
        basePath = new URL(args.baseUrl).pathname;
    } catch {
        // Non-absolute baseUrl (host-only form handled by `extractHost`): no path.
    }

    if (basePath !== "" && !isOnlySlashesPath(basePath)) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/storage: baseUrl must not carry a path ("${basePath}") — the key is verified from the full URL pathname, so a subpath base would make every signed URL fail verification`,
        );
    }

    // The canonical is newline-delimited and `key` is not its last field, so a
    // key containing a raw CR/LF could shift `exp` (and `contentType`) on
    // re-split — reject it here rather than minting a URL two different keys
    // could both satisfy. See `shared/hmac-url.ts#assertCanonicalSafe`.
    assertCanonicalSafe(args.key);
    // Same reason as the key: `bucketName` is not the canonical's last field.
    assertCanonicalSafe(args.bucketName);

    if (args.bucketName === "") {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: bucketName must not be empty");
    }

    // Same reason, and the same guard `createStorage`'s `validateKey` applies to
    // every other key that enters storage: an empty key mints a URL whose
    // pathname is the bare origin, which `verifySignedUrl` then validates and
    // hands the serving route as `key: ""`. `buildSignedUrl` is exported, so a
    // caller reaching it directly is the one path that never met `validateKey`.
    if (args.key === "") {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: key must not be empty");
    }

    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const host = extractHost(args.baseUrl);
    const sig = await signCanonical(args.secret, canonicalize(method, host, args.bucketName, args.key, exp, contentType));

    const base = trimTrailingSlashes(args.baseUrl);
    const safeKey = args.key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    const ctParameter = contentType === undefined ? "" : `&ct=${encodeURIComponent(contentType)}`;

    return `${base}/${safeKey}?exp=${String(exp)}&method=${method}&bucket=${encodeURIComponent(args.bucketName)}&sig=${sig}${ctParameter}`;
};

export interface VerifyResult {
    /**
     * The bucket the URL was minted for. The serving route MUST resolve its R2
     * binding from this (never from a caller-supplied bucket), since one signing
     * secret covers every bucket of a `.storage()` declaration.
     */
    bucketName?: string;
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
    // The bucket the signature was minted for. Every minted URL carries it, so a
    // URL without one is malformed — never silently treated as the default
    // bucket, which is the cross-bucket confusion this parameter exists to stop.
    const bucketName = url.searchParams.get("bucket");
    // A PUT-only content-type pin. Absent → undefined, which canonicalizes the
    // no-`ct` (GET / unpinned PUT) form.
    const contentType = url.searchParams.get("ct") ?? undefined;

    if (!sig || !bucketName || !Number.isInteger(exp)) {
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
        assertCanonicalSafe(bucketName);
        sigBytes = fromBase64Url(sig);
    } catch {
        return { reason: "malformed", valid: false };
    }

    // Canonicalize against an explicit expected host when supplied (CDN/host-
    // rewrite topologies); otherwise bind to the inbound host, which equals the
    // build-side host whenever the verified URL is the minted URL.
    const host = options?.expectedHost === undefined ? url.host : extractHost(options.expectedHost);
    const valid = await verifyCanonical(secret, canonicalize(method, host, bucketName, key, exp, contentType), sigBytes);

    if (!valid) {
        return { reason: "bad_signature", valid: false };
    }

    return { bucketName, contentType, key, method, valid: true };
};
