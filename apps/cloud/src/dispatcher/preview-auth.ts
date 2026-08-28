/**
 * Deployment protection for preview deployments (GAPS.md B-series follow-on).
 *
 * A preview deployment is a real, publicly-addressable URL the moment it exists.
 * That is the point of a preview — you paste it to a colleague — but it also
 * means an unreleased feature, a staging dataset and a half-finished page are all
 * served to anyone who guesses or is forwarded the hostname. Every comparable
 * platform gates previews behind something; this is that gate.
 *
 * **Where the secret lives.** The password's salted hash never leaves the control
 * plane: the dispatcher forwards a submitted password for verification and, on
 * success, mints a signed cookie. Every later request is then a LOCAL signature
 * check with no round trip, so protection costs one control-plane call per login
 * rather than one per request.
 *
 * **Where the signing key comes from.** Derived from the control-plane token the
 * dispatcher already holds, domain-separated by a fixed label
 * (`HMAC(token, "lunora-preview-auth-v1")`). Two reasons: a bearer token must not
 * double as a signing key — different purpose, different key — and deriving means
 * the feature works the moment someone enables protection, rather than depending
 * on an operator having provisioned yet another secret that, if missed, would
 * leave previews silently unprotected. Rotating the control-plane token
 * invalidates outstanding cookies, which is the correct blast radius.
 *
 * Signing, verification and cookie parsing are pure and unit-tested; only the
 * WebCrypto calls are async.
 */
import { constantTimeEqual } from "../security/constant-time-equal";

/** Cookie the dispatcher sets once a preview password has been accepted. */
const PREVIEW_COOKIE_NAME = "__lunora_preview";

/** Domain-separation label — see the module note on why the key is derived rather than reused. */
const SIGNING_LABEL = "lunora-preview-auth-v1";

/** How long a preview session lasts before the password is asked for again (12 h). */
const PREVIEW_SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * Base64url without padding — cookie-safe, and what the token halves are encoded
 * in.
 *
 * `fromCharCode`, not `fromCodePoint`: this walks BYTES (0–255) on their way into
 * `btoa`, which is defined over a binary string. Code points are the wrong unit
 * here — anything above 0xFF is not a byte, and treating it as one would corrupt
 * the signature rather than merely mis-render it.
 */
const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        // eslint-disable-next-line unicorn/prefer-code-point -- binary string for `btoa`: the unit is a byte, not a code point
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** Inverse of {@link toBase64Url}; throws on input that is not valid base64url. */
const fromBase64Url = (value: string): Uint8Array => {
    const padded = value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);

    // eslint-disable-next-line unicorn/prefer-code-point -- `atob` yields a binary string; each unit is a byte
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Derive the HMAC key for cookie signing from the control-plane token. */
const signingKey = async (controlPlaneToken: string): Promise<CryptoKey> => {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(controlPlaneToken), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(SIGNING_LABEL));

    return crypto.subtle.importKey("raw", derived, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
};

/** The claims a preview cookie carries. Deliberately tiny — a scope and a deadline, nothing else. */
interface PreviewClaims {
    /** Expiry, epoch millis. */
    exp: number;
    /** The script this cookie authorises. A cookie for one preview must not open another. */
    script: string;
}

/**
 * Mint a signed cookie value authorising one script until `now + PREVIEW_SESSION_MS`.
 *
 * The script name is inside the SIGNED payload rather than implied by the cookie's
 * host. Preview hostnames share a parent domain, so a host-scoped cookie would be
 * sent to every other preview in the account — signing the scope means a cookie
 * for one preview is rejected by the next even though the browser offers it.
 */
export const signPreviewToken = async (script: string, controlPlaneToken: string, now: number = Date.now()): Promise<string> => {
    const claims: PreviewClaims = { exp: now + PREVIEW_SESSION_MS, script };
    const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign("HMAC", await signingKey(controlPlaneToken), new TextEncoder().encode(payload));

    return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
};

/**
 * Verify a cookie value for one script. `false` for anything that is not a valid,
 * unexpired signature over that exact script.
 *
 * Verification recomputes the signature and compares in constant time rather than
 * trusting the payload first: the claims are attacker-supplied until the MAC says
 * otherwise, so nothing is read out of them before the check passes.
 */
export const verifyPreviewToken = async (token: string, script: string, controlPlaneToken: string, now: number = Date.now()): Promise<boolean> => {
    const separator = token.indexOf(".");

    if (separator <= 0 || separator === token.length - 1) {
        return false;
    }

    const payload = token.slice(0, separator);
    const presented = token.slice(separator + 1);

    let expected: string;

    try {
        const signature = await crypto.subtle.sign("HMAC", await signingKey(controlPlaneToken), new TextEncoder().encode(payload));

        expected = toBase64Url(new Uint8Array(signature));
    } catch {
        return false;
    }

    if (!constantTimeEqual(presented, expected)) {
        return false;
    }

    // Only now are the claims trustworthy enough to read.
    let claims: PreviewClaims;

    try {
        claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as PreviewClaims;
    } catch {
        return false;
    }

    return claims.script === script && typeof claims.exp === "number" && claims.exp > now;
};

/**
 * Read one cookie's value out of a `Cookie` header.
 *
 * Splits on `;` and takes the first `=` only, because a base64url payload can
 * itself contain no `=` but the joined token can — a naive `split("=")` would
 * truncate the value.
 */
export const readCookie = (header: null | string, name: string = PREVIEW_COOKIE_NAME): string | undefined => {
    for (const part of (header ?? "").split(";")) {
        const trimmed = part.trim();
        const equals = trimmed.indexOf("=");

        if (equals > 0 && trimmed.slice(0, equals) === name) {
            return trimmed.slice(equals + 1);
        }
    }

    return undefined;
};

/**
 * The `Set-Cookie` value for a minted token.
 *
 * `HttpOnly` because no script needs to read it and a preview is exactly where
 * half-finished code runs; `Secure` because previews are HTTPS-only; `SameSite=Lax`
 * so following a shared link still carries it while a cross-site POST does not.
 * Host-scoped (no `Domain`) so the browser does not offer it to sibling previews —
 * belt to the signed scope's braces.
 */
export const previewCookieHeader = (token: string): string =>
    `${PREVIEW_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(Math.floor(PREVIEW_SESSION_MS / 1000))}`;

export { PREVIEW_COOKIE_NAME, PREVIEW_SESSION_MS };
