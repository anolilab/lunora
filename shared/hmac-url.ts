/**
 * Canonical HMAC-SHA256 signed-URL primitives shared by `@lunora/storage`
 * (`buildSignedUrl`/`verifySignedUrl`) and `@lunora/bindings` images
 * (`buildSignedImageUrl`/`verifySignedImageUrl`). Both mint Worker-resolved
 * signed URLs with the same crypto envelope — base64url codec, a bounded
 * per-secret `CryptoKey` cache, host extraction, and sign/verify over a
 * canonical string — differing only in what each binds into that canonical
 * (storage: method + content-type; images: transform) and how it assembles the
 * URL.
 *
 * This is a cryptographic verification path, so it must have exactly ONE
 * definition rather than byte-similar copies that can drift: a future fix to the
 * base64url padding or the constant-time verify applied to one file and not the
 * other would be a silent security divergence. Mirrors `shared/constant-time-equal.ts`.
 *
 * Callers keep their own `canonicalize` (the only real per-package difference)
 * and decode the inbound signature themselves — `verifyCanonical` takes already
 * base64url-decoded bytes so each caller can map a malformed signature to its
 * own "malformed" (vs "bad_signature") diagnostic before calling in.
 *
 * Like `shared/constant-time-equal.ts`, this is deliberately **not** a package:
 * consumers import it by relative path and the bundler (packem/rollup) inlines
 * it — no runtime dependency edge. Keep it genuinely zero-dependency
 * (relative/built-in imports only) or inlining breaks. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */
import { evictOldestEntry } from "./evict-oldest";

const textEncoder = new TextEncoder();

/** Upper bound on a signed-URL TTL — 7 days, matching common CDN/object-store ceilings. */
const MAX_SIGNED_URL_TTL_SECONDS: number = 7 * 24 * 60 * 60;

// Hoisted to module scope so the literal isn't recompiled on every call.
const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+\-.]*:\/\//i;

const toBase64Url = (bytes: Uint8Array): string => {
    // A SHA-256 HMAC is a fixed 32 bytes, well under the argument-spread limit,
    // so building the binary string in one `fromCodePoint` call is safe and
    // cheaper than a per-byte loop. Each byte is < 256, so code point and char
    // code are identical here.
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
// the Promise (not the resolved key) also coalesces concurrent imports. The
// cache is bounded (FIFO eviction) so a multi-tenant app cycling through many
// per-tenant secrets can't accumulate unbounded memory. 64 distinct
// secrets/isolate is well above any realistic use, and isolates recycle anyway.
const KEY_CACHE_MAX = 64;
const keyCache = new Map<string, Promise<CryptoKey>>();

const importHmacKey = async (secret: string): Promise<CryptoKey> => {
    const cached = keyCache.get(secret);

    if (cached) {
        return cached;
    }

    evictOldestEntry(keyCache, KEY_CACHE_MAX);

    const keyPromise = crypto.subtle.importKey("raw", textEncoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]);

    keyCache.set(secret, keyPromise);

    return keyPromise;
};

/**
 * Extract `host[:port]` from a full URL or a bare host/base form. Tolerates a
 * host-only string by trying `URL` first and falling back to splitting off the
 * path. Case is preserved; lowercasing (DNS is case-insensitive) is the caller's
 * job inside `canonicalize`.
 */
const extractHost = (input: string): string => {
    try {
        return new URL(input).host;
    } catch {
        const noScheme = input.replace(SCHEME_PREFIX_RE, "");

        return noScheme.split("/")[0] ?? "";
    }
};

/** Sign `canonical` with the secret's HMAC key, returning the base64url signature. */
const signCanonical = async (secret: string, canonical: string): Promise<string> => {
    const cryptoKey = await importHmacKey(secret);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(canonical));

    return toBase64Url(new Uint8Array(signature));
};

/**
 * Constant-time verify (via `crypto.subtle.verify`) of already base64url-decoded
 * `sigBytes` over `canonical`. The caller decodes the inbound signature itself
 * (mapping a decode throw to its own "malformed" diagnostic) and passes the
 * bytes here.
 */
const verifyCanonical = async (secret: string, canonical: string, sigBytes: Uint8Array): Promise<boolean> => {
    const cryptoKey = await importHmacKey(secret);

    return crypto.subtle.verify("HMAC", cryptoKey, sigBytes as unknown as BufferSource, textEncoder.encode(canonical));
};

export { extractHost, fromBase64Url, MAX_SIGNED_URL_TTL_SECONDS, signCanonical, verifyCanonical };
