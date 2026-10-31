/**
 * Named admin tokens: the bearer format, the digest a shard stores in place of
 * the secret, and the signed signal the worker hands a shard instead of the
 * bearer.
 *
 *     token  = "lnat." + name + "." + base64url(32 random bytes)
 *     digest = hex(SHA-256(secret))
 *     signal = "as1." + expEpochMs + "." + name + "." + base64url(HMAC_SHA256(key = LUNORA_ADMIN_TOKEN, msg = "as1." + expEpochMs + "." + name))
 *
 * A plain SHA-256 is enough for the digest: the secret is 256 random bits, so
 * there is nothing for a slow hash to stretch. The name rides the token so a
 * lookup is one keyed read and a revoke is by name; it is not secret.
 *
 * The signal exists so a shard never sees a named token's secret. The worker
 * verifies the bearer, then forwards this instead; the shard checks the HMAC
 * with the root token both isolates already hold. Its `as1` tag and four-part
 * shape keep it from verifying as a WebSocket admin sub-token (`v1.<exp>.<sig>`)
 * and vice versa, although all three are keyed by the same root token.
 *
 * Not a package: `@lunora/runtime` and `@lunora/do` import it by relative path
 * and the bundler inlines it. Keep it zero-dependency.
 */
import { fromBase64Url, toBase64Url } from "./base64";
import { signCanonical, verifyCanonical } from "./hmac-url";

const ADMIN_TOKEN_PREFIX = "lnat";

/** The single instance of the admin revocation Durable Object, addressed with `idFromName`. */
const ADMIN_REVOCATION_DO_NAME = "__lunora_admin_revocations__";

/** Lowercase, no dots — the name is a `.`-delimited segment of both the token and the signal. */
const ADMIN_TOKEN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** 32 bytes of base64url, unpadded. */
const ADMIN_TOKEN_SECRET_RE = /^[\w-]{43}$/u;

/** Header the worker sets on a shard request it authorized with a named token. */
const ADMIN_SIGNAL_HEADER = "x-lunora-admin-signal";

const ADMIN_SIGNAL_VERSION = "as1";

/** Minted per forwarded request, so it only has to outlive one worker-to-shard hop. */
const ADMIN_SIGNAL_TTL_MS = 60_000;

/**
 * The least a signal may live, however close its grant is to leaving the cache:
 * the worker-to-shard hop must not outlast a signal minted a millisecond before
 * the cache window ends. Still short enough to leave the revocation window at
 * the cache TTL plus a few seconds.
 */
const ADMIN_SIGNAL_MIN_TTL_MS = 5000;

const isValidAdminTokenName = (name: string): boolean => ADMIN_TOKEN_NAME_RE.test(name);

/** Split a bearer into name and secret, or `undefined` when it is not a named token. Pure — no I/O. */
const parseAdminToken = (bearer: string): undefined | { name: string; secret: string } => {
    const parts = bearer.split(".");

    if (parts.length !== 3 || parts[0] !== ADMIN_TOKEN_PREFIX) {
        return undefined;
    }

    const [, name, secret] = parts as [string, string, string];

    return isValidAdminTokenName(name) && ADMIN_TOKEN_SECRET_RE.test(secret) ? { name, secret } : undefined;
};

/** {@link parseAdminToken} over an `Authorization` header value. */
const parseAdminTokenHeader = (authorization: null | string | undefined): ReturnType<typeof parseAdminToken> => {
    const match = authorization ? /^bearer\s+(\S+)\s*$/iu.exec(authorization) : undefined;

    return match?.[1] === undefined ? undefined : parseAdminToken(match[1]);
};

const generateAdminToken = (name: string): { secret: string; token: string } => {
    const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

    return { secret, token: `${ADMIN_TOKEN_PREFIX}.${name}.${secret}` };
};

const digestAdminTokenSecret = async (secret: string): Promise<string> => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));

    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** `notAfter` caps the signal at the token's own validity, so a signal never outlives the token it vouches for. */
const mintAdminSignal = async (rootToken: string, name: string, now: number = Date.now(), notAfter: number = Number.POSITIVE_INFINITY): Promise<string> => {
    // Whole milliseconds: a fractional expiry would add a `.` to the dot-separated signal.
    const canonical = `${ADMIN_SIGNAL_VERSION}.${String(Math.floor(Math.min(now + ADMIN_SIGNAL_TTL_MS, notAfter)))}.${name}`;

    return `${canonical}.${await signCanonical(rootToken, canonical)}`;
};

/**
 * The token name a signal carries, or `undefined` for a malformed, expired,
 * tampered or wrong-key signal. Never throws.
 */
const verifyAdminSignal = async (rootToken: string, signal: string, now: number = Date.now()): Promise<string | undefined> => {
    if (rootToken.length === 0) {
        return undefined;
    }

    const parts = signal.split(".");

    if (parts.length !== 4) {
        return undefined;
    }

    const [version, expString, name, signature] = parts as [string, string, string, string];
    const expiresAtMs = Number(expString);

    if (version !== ADMIN_SIGNAL_VERSION || !isValidAdminTokenName(name) || !Number.isFinite(expiresAtMs) || expiresAtMs <= now || signature.length === 0) {
        return undefined;
    }

    let signatureBytes: Uint8Array;

    try {
        signatureBytes = fromBase64Url(signature);
    } catch {
        return undefined;
    }

    return (await verifyCanonical(rootToken, `${version}.${expString}.${name}`, signatureBytes)) ? name : undefined;
};

export {
    ADMIN_REVOCATION_DO_NAME,
    ADMIN_SIGNAL_HEADER,
    ADMIN_SIGNAL_MIN_TTL_MS,
    ADMIN_SIGNAL_TTL_MS,
    digestAdminTokenSecret,
    generateAdminToken,
    isValidAdminTokenName,
    mintAdminSignal,
    parseAdminToken,
    parseAdminTokenHeader,
    verifyAdminSignal,
};
