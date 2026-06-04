import type { SignedUrlOptions } from "./types.js";

const textEncoder = new TextEncoder();

/** Upper bound on a signed-URL TTL — 7 days, matching common CDN/object-store ceilings. */
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

// Hoisted to module scope so the literals aren't recompiled on every call.
const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+\-.]*:\/\//i;
const LEADING_SLASH_RE = /^\//;

const toBase64Url = (bytes: Uint8Array): string => {
    // A SHA-256 HMAC is a fixed 32 bytes, well under the argument-spread limit,
    // so building the binary string in one `fromCharCode` call is safe and
    // cheaper than a per-byte loop.
    const binary = String.fromCharCode(...bytes);

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
const keyCache = new Map<string, Promise<CryptoKey>>();

const importHmacKey = async (secret: string): Promise<CryptoKey> => {
    const cached = keyCache.get(secret);

    if (cached) {
        return cached;
    }

    const keyPromise = crypto.subtle.importKey("raw", textEncoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);

    keyCache.set(secret, keyPromise);

    return keyPromise;
};

// Host is lowercased so a signature minted for `Example.com` verifies against
// `example.com` — DNS is case-insensitive, but the URL parser preserves case.
const canonicalize = (method: "GET" | "PUT", host: string, key: string, exp: number): string => `${method}\n${host.toLowerCase()}\n${key}\n${String(exp)}`;

const extractHost = (input: string): string => {
    // Tolerate a bare host-or-base by trying URL first; fall back to splitting
    // off the path. Either way, the canonical form is just `host[:port]`.
    try {
        return new URL(input).host;
    } catch {
        const noScheme = input.replace(SCHEME_PREFIX_RE, "");

        return noScheme.split("/")[0] ?? "";
    }
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
        throw new Error("@cirrus/storage: expiresInSeconds must be a positive finite number");
    }

    if (expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
        throw new Error(`@cirrus/storage: expiresInSeconds must not exceed ${String(MAX_EXPIRES_IN_SECONDS)} (7 days)`);
    }

    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const host = extractHost(args.baseUrl);
    const cryptoKey = await importHmacKey(args.secret);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(canonicalize(method, host, args.key, exp)));
    const sig = toBase64Url(new Uint8Array(signature));

    const base = args.baseUrl.endsWith("/") ? args.baseUrl.slice(0, -1) : args.baseUrl;
    const safeKey = args.key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    return `${base}/${safeKey}?exp=${String(exp)}&method=${method}&sig=${sig}`;
};

export interface VerifyResult {
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
        sigBytes = fromBase64Url(sig);
    } catch {
        return { reason: "malformed", valid: false };
    }

    // Canonicalize against an explicit expected host when supplied (CDN/host-
    // rewrite topologies); otherwise bind to the inbound host, which equals the
    // build-side host whenever the verified URL is the minted URL.
    const host = options?.expectedHost === undefined ? url.host : extractHost(options.expectedHost);
    const cryptoKey = await importHmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", cryptoKey, sigBytes as unknown as BufferSource, textEncoder.encode(canonicalize(method, host, key, exp)));

    if (!valid) {
        return { reason: "bad_signature", valid: false };
    }

    return { key, method, valid: true };
};
