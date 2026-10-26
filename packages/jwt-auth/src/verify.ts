import { LunoraError } from "@lunora/errors";
import type { CryptoKey, JWTPayload, JWTVerifyGetKey, KeyObject } from "jose";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

const WHITESPACE = /\s+/u;
const SCHEME = /^https?:\/\//iu;

/** Where a verifier reads the raw token from. Return `null`/`undefined` for "no token" (anonymous). */
type TokenSource = (request: Request) => string | null | undefined;

/**
 * A verification key: a key-set getter (`createLocalJWKSet`, `createRemoteJWKSet`)
 * or one public key. Asymmetric only: the default `algorithms` are asymmetric, so
 * an HMAC secret would never verify, and accepting one would invite pairing it
 * with an HMAC algorithm that anyone holding the "public" value could forge.
 */
type JwtKeySet = CryptoKey | JWTVerifyGetKey | KeyObject;

/** Algorithms accepted when `algorithms` is not set: asymmetric only, so an `alg: none` or HMAC forgery never verifies against a public key set. */
const DEFAULT_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

interface JwtVerifierOptions {
    /**
     * Allowed signing algorithms. Defaults to every asymmetric JOSE algorithm;
     * pin it to what your provider signs with (the presets do).
     */
    algorithms?: string[];

    /**
     * Expected `aud`. Verified only when set — set it whenever your provider
     * issues one (Auth0's API identifier, Supabase's `authenticated`): without
     * it, any token the issuer minted for another application verifies too.
     */
    audience?: string | string[];

    /** Seconds of clock skew tolerated on `exp` / `nbf` / `iat`. */
    clockTolerance?: number;

    /**
     * Expected `iss`. Required unless `jwksUrl` or `keySet` is set, in which case
     * it is still strongly recommended. When neither is set the key set is
     * discovered from `<issuer>/.well-known/openid-configuration` of the FIRST
     * issuer listed; that issuer must be https and the discovery document must
     * name it as its `issuer`.
     */
    issuer?: string | string[];

    /** URL of the provider's JSON Web Key Set. */
    jwksUrl?: string | URL;

    /** A key used instead of fetching one (a PEM public key imported with `importSPKI`, a local JWKS, or a test key). */
    keySet?: JwtKeySet;

    /** Observe a present-but-invalid token (bad signature, wrong issuer…). Never fires for a missing token. Throws are swallowed. */
    onError?: (error: unknown, request: Request) => void;

    /** Claims the token must carry. Defaults to `["exp"]`: a token without an expiry would stay valid forever. */
    requiredClaims?: string[];

    /** Where to read the token. Defaults to {@link bearerToken}. */
    token?: TokenSource;
}

/** A verified token. `expired` is set when its ONLY fault is a past `exp`. */
interface VerifiedJwt {
    expired: boolean;
    payload: JWTPayload;
}

/** Reads the request's token and verifies it; `undefined` for no token or a token that failed verification. */
type JwtVerifier = (request: Request) => Promise<VerifiedJwt | undefined>;

/** Narrow a claim to a non-empty string; `""` and anything that is not a string are absent. */
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** The `https://` origin of a configured host or URL (`acme.auth0.com`, `https://clerk.example.com/`), throwing when it is empty. */
const httpsOrigin = (value: string, name: string): string => {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
        throw new LunoraError("INTERNAL", `\`${name}\` is empty — check that the env var holding it is set`);
    }

    return new URL(SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`).origin;
};

/** The named header's value, verbatim. */
const headerToken =
    (name: string): TokenSource =>
    (request) =>
        nonEmpty(request.headers.get(name));

/** The `Authorization: Bearer <token>` value, or `undefined`. */
const bearerToken: TokenSource = (request) => {
    const header = request.headers.get("authorization");

    if (header === null) {
        return undefined;
    }

    const [scheme, value] = header.trim().split(WHITESPACE, 2);

    return scheme?.toLowerCase() === "bearer" ? nonEmpty(value) : undefined;
};

/** A token source reading the named cookie. */
const cookieToken =
    (name: string): TokenSource =>
    (request) => {
        const cookieHeader = request.headers.get("cookie");

        if (cookieHeader === null) {
            return undefined;
        }

        for (const part of cookieHeader.split(";")) {
            const eq = part.indexOf("=");

            if (eq !== -1 && part.slice(0, eq).trim() === name) {
                return nonEmpty(part.slice(eq + 1).trim());
            }
        }

        return undefined;
    };

/** First source that yields a token wins. `firstToken(bearerToken, cookieToken("__session"))`. */
const firstToken =
    (...sources: TokenSource[]): TokenSource =>
    (request) => {
        for (const source of sources) {
            const token = source(request);

            if (token) {
                return token;
            }
        }

        return undefined;
    };

/**
 * One remote key set per URL for the life of the isolate. `jose`'s getter
 * caches the fetched keys and refetches (with a cooldown) when a token names a
 * `kid` it does not hold — which is exactly key rotation — so a single shared
 * instance is correct and re-creating it per request would defeat that cache.
 */
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

const remoteKeySet = (url: string): JWTVerifyGetKey => {
    let keySet = remoteKeySets.get(url);

    if (keySet === undefined) {
        keySet = createRemoteJWKSet(new URL(url));
        remoteKeySets.set(url, keySet);
    }

    return keySet;
};

/**
 * OIDC discovery, cached per issuer; a failed lookup is dropped so the next
 * request retries. The document must name the configured issuer exactly (OIDC
 * Discovery §4.3), so a document served for another issuer cannot hand over its keys.
 */
const discoveries = new Map<string, Promise<string>>();

const discoverJwksUrl = (issuer: string): Promise<string> => {
    let pending = discoveries.get(issuer);

    if (pending === undefined) {
        pending = (async () => {
            const response = await fetch(new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : `${issuer}/`));

            if (!response.ok) {
                throw new Error(`OIDC discovery for ${issuer} failed with HTTP ${String(response.status)}`);
            }

            const body: unknown = await response.json();
            const document = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

            if (document.issuer !== issuer) {
                throw new Error(`OIDC discovery for ${issuer} returned a document for issuer ${JSON.stringify(document.issuer)}`);
            }

            const jwksUri = document["jwks_uri"];

            if (typeof jwksUri !== "string" || !jwksUri.startsWith("https://")) {
                throw new Error(`OIDC discovery for ${issuer} returned no https jwks_uri`);
            }

            return jwksUri;
        })();

        discoveries.set(issuer, pending);
        pending.catch(() => discoveries.delete(issuer));
    }

    return pending;
};

const issuerList = (issuer: JwtVerifierOptions["issuer"]): string[] =>
    (Array.isArray(issuer) ? issuer : [issuer]).filter((value): value is string => nonEmpty(value) !== undefined);

/**
 * Verify one compact JWT and return its payload, throwing `jose`'s error on any
 * failure. Checks the signature against `keySet`, `jwksUrl` or the key set OIDC
 * discovery finds for the first `issuer`, then `iss`, `aud`, `alg`, the
 * `requiredClaims`, `exp` / `nbf`, and that `iat` is not in the future (`jose`
 * checks `iat` only together with `maxTokenAge`).
 */
const verifyJwt = async (token: string, options: Omit<JwtVerifierOptions, "onError" | "token">): Promise<JWTPayload> => {
    const issuers = issuerList(options.issuer);
    const jwksUrl = options.jwksUrl === undefined ? undefined : String(options.jwksUrl);
    const keySet = options.keySet ?? remoteKeySet(jwksUrl ?? (await discoverJwksUrl(issuers[0] ?? "")));
    const clockTolerance = options.clockTolerance ?? 0;

    const { payload } = await jwtVerify(token, keySet as Parameters<typeof jwtVerify>[1], {
        algorithms: options.algorithms ?? DEFAULT_ALGORITHMS,
        audience: options.audience,
        clockTolerance,
        issuer: issuers.length > 0 ? issuers : undefined,
        requiredClaims: options.requiredClaims ?? ["exp"],
    });

    if (typeof payload.iat === "number" && payload.iat > Date.now() / 1000 + clockTolerance) {
        throw new errors.JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", "check_failed");
    }

    return payload;
};

/**
 * Create the verify step every Lunora JWT adapter shares: read the token from
 * the request, verify it with {@link verifyJwt}, and report the outcome without
 * throwing. No token, or a token that fails verification, yields `undefined`;
 * `onError` observes the failure.
 *
 * The one failure that still yields the payload is a past `exp`: `jose` checks
 * the signature, `iss` and `aud` before `exp`, so such a token is a genuine
 * credential that lapsed. It comes back with `expired: true` so a caller can
 * answer `TOKEN_EXPIRED` (the client refreshes) instead of running the request
 * anonymous — or refuse it, as an admin gate does.
 *
 * Misconfiguration throws here, at wiring time: an unset env var must not boot a
 * worker that resolves every caller to anonymous with no signal.
 */
const jwtVerifier = (options: JwtVerifierOptions): JwtVerifier => {
    const issuers = issuerList(options.issuer);
    const jwksUrl = options.jwksUrl === undefined ? undefined : String(options.jwksUrl);

    if (issuers.length === 0 && nonEmpty(jwksUrl) === undefined && options.keySet === undefined) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: set `issuer` (OIDC discovery) or `jwksUrl` — check that the env var holding it is set");
    }

    if (jwksUrl !== undefined && !jwksUrl.startsWith("https://")) {
        throw new LunoraError("INTERNAL", `@lunora/jwt-auth: \`jwksUrl\` must be an https URL, got "${jwksUrl}"`);
    }

    if (jwksUrl === undefined && options.keySet === undefined && !(issuers[0] ?? "").startsWith("https://")) {
        throw new LunoraError("INTERNAL", `@lunora/jwt-auth: OIDC discovery needs an https \`issuer\`, got "${issuers[0] ?? ""}"`);
    }

    const readToken = options.token ?? bearerToken;

    return async (request) => {
        const token = readToken(request);

        if (!token) {
            return undefined;
        }

        try {
            return { expired: false, payload: await verifyJwt(token, options) };
        } catch (error) {
            try {
                options.onError?.(error, request);
            } catch {
                /* an observer must not turn a verification failure into a request error */
            }

            return error instanceof errors.JWTExpired && error.claim === "exp" ? { expired: true, payload: error.payload } : undefined;
        }
    };
};

export type { JwtKeySet, JwtVerifier, JwtVerifierOptions, TokenSource, VerifiedJwt };
export { bearerToken, cookieToken, firstToken, headerToken, httpsOrigin, jwtVerifier, nonEmpty, verifyJwt };
