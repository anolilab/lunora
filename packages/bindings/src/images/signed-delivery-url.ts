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

import {
    assertCanonicalSafe,
    extractHost,
    fromBase64Url,
    isOnlySlashesPath,
    MAX_SIGNED_URL_TTL_SECONDS,
    signCanonical,
    validateTtlSeconds,
    verifyCanonical,
} from "../../../../shared/hmac-url";
import type { TransformOptions } from "./types";

// Hoisted to module scope so the literals aren't recompiled on every call. The
// base64url codec, bounded key cache, host extraction, sign/verify, and the
// base-path predicate live in `shared/hmac-url.ts` (shared byte-for-byte with
// `@lunora/storage`).
const LEADING_SLASH_RE = /^\//;

// Strip every trailing slash from the base URL — a linear scan (no regex
// backtracking), mirroring `@lunora/storage`'s `trimTrailingSlashes` so an
// accepted only-slashes base like `https://cdn.test//` joins to a single-slash
// pathname the verifier's key reconstruction agrees with.
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

/**
 * Percent-escape the two characters that are structural in the serialized
 * transform: `&` separates entries and `=` separates a key from its value.
 *
 * Without this the encoding is ambiguous, and the signature binds the ambiguous
 * string — so a value carrying them decodes to a transform the signer never
 * authorised. A `background` (or `gravity`) fed from user input and set to
 * `blue&width=10000` minted a URL whose verified transform really did request a
 * 10000px render, under a signature that checks out. The same ambiguity
 * truncated legitimate values from the other side: a JSON-valued `gravity`
 * carrying an escaped separator had its JSON cut at the `&`.
 *
 * `%` itself is deliberately NOT escaped, so a percent-encoded value that works
 * today (`background=%23ff0000`) keeps canonicalizing byte-for-byte and its
 * outstanding signed URLs keep verifying. The cost is that a value containing
 * the literal text `%26` decodes to `&` — which can only ever place a literal
 * `&` INSIDE one value, never split a new entry out of it, so it cannot forge a
 * key. The only URLs whose canonical this changes are the ones that were
 * already decoding to the wrong transform.
 */
const escapeTransformValue = (value: string): string => value.replaceAll("&", "%26").replaceAll("=", "%3D");

/** The exact inverse of {@link escapeTransformValue}. */
const unescapeTransformValue = (value: string): string => value.replaceAll("%3D", "=").replaceAll("%26", "&");

// Stable, order-independent serialization of the transform so the same options
// canonicalize byte-for-byte regardless of key insertion order. Object-valued
// keys (e.g. gravity coordinates) are JSON-encoded; primitives stringify plainly.
// MUST stay the exact inverse of `parseSignedTransform` below — the round-trip
// test in `__tests__/images/signed-delivery-url.test.ts` pins the pairing.
const serializeTransform = (transform: TransformOptions | undefined): string => {
    if (transform === undefined) {
        return "";
    }

    return Object.entries(transform)
        .filter(([, value]) => value !== undefined)
        .toSorted(([a], [b]) => (a > b ? 1 : 0) - (a < b ? 1 : 0))
        .map(([key, value]) => `${key}=${escapeTransformValue(typeof value === "object" ? JSON.stringify(value) : String(value))}`)
        .join("&");
};

/** The value encodings `serializeTransform` can emit for a `TransformOptions` key. */
type TransformValueKind = "number" | "string" | "string-or-json";

/**
 * Per-key value kind for {@link parseSignedTransform}, derived from the
 * declared {@link TransformOptions} type — the parser coerces by the type, not
 * by sniffing the value (`background` is a string even when it looks numeric).
 * `gravity` is the one union: a bare enum string, or a JSON object (which
 * always starts with `{`, so the two are unambiguous).
 */
const TRANSFORM_KEY_KINDS = {
    background: "string",
    blur: "number",
    brightness: "number",
    contrast: "number",
    fit: "string",
    flip: "string",
    gamma: "number",
    gravity: "string-or-json",
    height: "number",
    rotate: "number",
    saturation: "number",
    segment: "string",
    sharpen: "number",
    upscale: "string",
    width: "number",
} as const satisfies Record<keyof Required<TransformOptions>, TransformValueKind>;

/** String-keyed view of {@link TRANSFORM_KEY_KINDS} for lookups from parsed input. */
const KIND_BY_KEY: ReadonlyMap<string, TransformValueKind> = new Map(Object.entries(TRANSFORM_KEY_KINDS));

/** Coerce one serialized transform value back to its declared type; throws `TypeError` naming the key on drift. */
const coerceTransformValue = (key: string, kind: TransformValueKind, raw: string): unknown => {
    if (kind === "string" || (kind === "string-or-json" && !raw.startsWith("{"))) {
        return raw;
    }

    if (kind === "number") {
        const value = Number(raw);

        if (raw === "" || !Number.isFinite(value)) {
            throw new TypeError(`@lunora/bindings/images: transform key "${key}" expects a number, got "${raw}"`);
        }

        return value;
    }

    try {
        return JSON.parse(raw) as unknown;
    } catch {
        throw new TypeError(`@lunora/bindings/images: transform key "${key}" carries malformed JSON`);
    }
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

/**
 * Parse a verified transform string (the `t` query value handed back by
 * {@link verifySignedImageUrl}) back into the {@link TransformOptions} it was
 * serialized from, so the Worker can apply exactly the signed transform via
 * `ctx.images.transform(...)` without hand-writing the inverse encoding.
 *
 * The exact inverse of `serializeTransform` above — the two MUST evolve
 * together (the round-trip test in
 * `__tests__/images/signed-delivery-url.test.ts` pins the pairing). Throws a
 * `TypeError` on an unknown key or an uncoercible value: the input is meant to
 * be a string whose HMAC already verified, so a parse failure means
 * encoder/decoder drift in the library, never user input — fail loud rather
 * than silently un-binding the transform the signature protects.
 */
export const parseSignedTransform = (t: string): TransformOptions => {
    if (t === "") {
        return {};
    }

    const options: Record<string, unknown> = {};

    // A plain `split("&")` is exact: `serializeTransform` escapes both
    // separators inside every value, so each `&` here really does start a new
    // entry and each entry holds exactly one `=`. The read side used to guess
    // instead — treating an `&` as a separator only when a known key followed —
    // which split a JSON value carrying an escaped `&` straight down the middle
    // and could never have told an injected key from a legitimate one anyway.
    for (const part of t.split("&")) {
        const eq = part.indexOf("=");

        if (eq === -1) {
            throw new TypeError(`@lunora/bindings/images: malformed transform segment "${part}" — expected key=value`);
        }

        const key = part.slice(0, eq);
        const kind = KIND_BY_KEY.get(key);

        if (kind === undefined) {
            throw new TypeError(
                `@lunora/bindings/images: unknown transform key "${key}" — the serialized transform does not match this version's TransformOptions`,
            );
        }

        options[key] = coerceTransformValue(key, kind, unescapeTransformValue(part.slice(eq + 1)));
    }

    return options;
};

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

    const ttlProblem = validateTtlSeconds(expiresInSeconds, MAX_SIGNED_URL_TTL_SECONDS);

    if (ttlProblem !== undefined) {
        throw new TypeError(`@lunora/bindings/images: ${ttlProblem}`);
    }

    // A path on `baseUrl` would be prepended to the key in the minted URL's
    // pathname (`${base}/${safeKey}`), but `verifySignedImageUrl` reconstructs
    // the key from the ENTIRE `url.pathname` and can't know the base prefix — so
    // a base mounted at a subpath makes every minted URL fail verification. The
    // signature only binds host + key, not the base path, so we can't recover it
    // on verify; reject it loudly here instead of silently minting dead URLs.
    // A pathname of only slashes is fine — the trailing-slash trim below
    // collapses it to the bare origin (see `isOnlySlashesPath` in
    // `shared/hmac-url.ts`).
    let basePath = "";

    try {
        basePath = new URL(options.baseUrl).pathname;
    } catch {
        // Non-absolute baseUrl (host-only form handled by `extractHost`): no path.
    }

    if (basePath !== "" && !isOnlySlashesPath(basePath)) {
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

    const base = trimTrailingSlashes(options.baseUrl);
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

    /**
     * The verified transform decoded back into the options object to pass to
     * `ctx.images.transform(...)` — {@link parseSignedTransform} applied to
     * `transform`. Left `undefined` when `transform` is absent, and also when a
     * genuinely signed transform carries a key this build does not know (an
     * old URL minted before a key was renamed): the request stays `valid`, the
     * raw `transform` is still returned, and the caller decides.
     */
    transformOptions?: TransformOptions;
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

    if (transform === "") {
        return { key, valid: true };
    }

    // A verified-but-unparseable transform must NOT throw out of the request
    // path: a signed URL outlives a deploy, so a rolling deploy or a renamed
    // `TransformOptions` key leaves genuine URLs whose transform this build
    // cannot read. Degrade to the pre-`transformOptions` behaviour — the raw
    // verified string, no decoded object — instead of turning a valid request
    // into an unhandled 500. Callers that want the parse error can call
    // `parseSignedTransform` on `transform` themselves.
    let transformOptions: TransformOptions | undefined;

    try {
        transformOptions = parseSignedTransform(transform);
    } catch {
        transformOptions = undefined;
    }

    return { key, transform, transformOptions, valid: true };
};
