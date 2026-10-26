import { LunoraError } from "@lunora/errors";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

import type { ExecutionContextLike } from "../../../shared/execution-context";

/**
 * The identity a resolver hands the runtime. Structurally the same as
 * `@lunora/runtime`'s `ResolvedIdentity` (projected, not imported, so this
 * package carries no runtime dependency): `userId` becomes `ctx.auth.userId`,
 * every other key is forwarded as `ctx.auth.getIdentity()` and read by RLS
 * (`roles` is the claim RLS role checks read).
 */
interface JwtIdentity {
    [claim: string]: unknown;
    /** Token expiry in epoch seconds. A past value makes the runtime answer `TOKEN_EXPIRED` (HTTP 401, socket close 4001). */
    exp?: number;
    userId: string;
}

/** Same shape as `WorkerOptions.resolveIdentity`, so the result plugs straight in. */
type JwtIdentityResolver = (request: Request, env?: unknown, context?: ExecutionContextLike) => Promise<JwtIdentity | null>;

/** `resolveIdentity`'s anonymous sentinel (its contract is `… | null`). */
// eslint-disable-next-line unicorn/no-null -- the runtime's resolveIdentity contract value for "anonymous"
const ANONYMOUS = null;

const WHITESPACE = /\s+/u;

/** Where the resolver reads the raw token from. Return `null`/`undefined` for "no token" (anonymous). */
type TokenSource = (request: Request) => string | null | undefined;

/** Algorithms accepted when `algorithms` is not set: asymmetric only, so an `alg: none` or HMAC forgery never verifies against a public key set. */
const DEFAULT_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

interface JwtIdentityResolverOptions {
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

    /**
     * Map the verified payload to the extra identity claims (org id, roles,
     * permissions…). Return `null` to treat a verified token as anonymous
     * (e.g. an authorized-party check failed). A returned `userId` overrides
     * the `sub` default. Runs for an expired-but-genuine token too, so such
     * checks hold on that path as well.
     */
    claims?: (payload: JWTPayload) => Record<string, unknown> | null;

    /** Seconds of clock skew tolerated on `exp` / `nbf` / `iat`. */
    clockTolerance?: number;

    /**
     * Expected `iss`. Required unless `jwksUrl` is set, in which case it is
     * still strongly recommended. When `jwksUrl` is omitted the key set is
     * discovered from `<issuer>/.well-known/openid-configuration`.
     */
    issuer?: string | string[];

    /** URL of the provider's JSON Web Key Set. */
    jwksUrl?: string | URL;

    /** Local key set (e.g. `createLocalJWKSet` or a `CryptoKey`), used instead of fetching one. Mostly for tests. */
    keySet?: JWTVerifyGetKey | CryptoKey | Uint8Array;

    /** Observe a present-but-invalid token (bad signature, wrong issuer…). Never fires for a missing token. Throws are swallowed. */
    onError?: (error: unknown, request: Request) => void;

    /** Where to read the token. Defaults to {@link bearerToken}. */
    token?: TokenSource;
}

/** The `Authorization: Bearer <token>` value, or `undefined`. */
const bearerToken: TokenSource = (request) => {
    const header = request.headers.get("authorization");

    if (header === null) {
        return undefined;
    }

    const [scheme, value] = header.trim().split(WHITESPACE, 2);

    return scheme?.toLowerCase() === "bearer" && value !== undefined && value.length > 0 ? value : undefined;
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
                const value = part.slice(eq + 1).trim();

                return value.length > 0 ? value : undefined;
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

/** OIDC discovery, cached per issuer; a failed lookup is dropped so the next request retries. */
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
            const jwksUri = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["jwks_uri"] : undefined;

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

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Build the identity from a verified payload, or `null` when the payload names no user or `claims` vetoes it. */
const toIdentity = (payload: JWTPayload, claims: JwtIdentityResolverOptions["claims"]): JwtIdentity | null => {
    const extra = claims ? claims(payload) : {};

    if (extra === null) {
        return ANONYMOUS;
    }

    const userId = nonEmpty(extra.userId) ?? nonEmpty(payload.sub);

    if (userId === undefined) {
        return ANONYMOUS;
    }

    return { ...extra, ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}), userId };
};

/**
 * Create a `resolveIdentity` that verifies a JWT from an external identity
 * provider against its JWKS and maps it to a Lunora identity: `sub` becomes
 * `ctx.auth.userId`, `exp` is forwarded, and `claims` adds whatever else RLS
 * should see.
 *
 * Fail-closed: no token, or a token that fails verification, resolves to
 * `null` (anonymous). The one exception is a token whose ONLY fault is a past
 * `exp` — `jose` checks the signature, `iss` and `aud` before `exp`, so it is a
 * genuine credential that lapsed. It resolves to its identity with that past
 * `exp`, which the runtime answers with `TOKEN_EXPIRED` (HTTP 401, socket close
 * 4001) so the client refreshes instead of silently running anonymous.
 *
 * ```ts
 * createWorker({
 *     resolveIdentity: jwtIdentityResolver({
 *         issuer: "https://auth.example.com/",
 *         audience: "https://api.example.com",
 *     }),
 *     shardDO: env.SHARD,
 * });
 * ```
 *
 * The resolver reads only the `Authorization` and `Cookie` headers, so
 * `memoizeIdentity`'s default cache key is safe for it.
 */
const jwtIdentityResolver = (options: JwtIdentityResolverOptions): JwtIdentityResolver => {
    const issuers = (Array.isArray(options.issuer) ? options.issuer : [options.issuer]).filter((value): value is string => nonEmpty(value) !== undefined);
    const jwksUrl = options.jwksUrl === undefined ? undefined : String(options.jwksUrl);

    // Fail at wiring time, not per request: an unset env var must not boot a
    // worker that resolves every caller to anonymous with no signal.
    if (issuers.length === 0 && nonEmpty(jwksUrl) === undefined && options.keySet === undefined) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: set `issuer` (OIDC discovery) or `jwksUrl` — check that the env var holding it is set");
    }

    if (jwksUrl !== undefined && !jwksUrl.startsWith("https://")) {
        throw new LunoraError("INTERNAL", `@lunora/jwt-auth: \`jwksUrl\` must be an https URL, got "${jwksUrl}"`);
    }

    const readToken = options.token ?? bearerToken;
    const algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;

    const keySetFor = async (): Promise<Parameters<typeof jwtVerify>[1]> => {
        if (options.keySet !== undefined) {
            return options.keySet;
        }

        return remoteKeySet(jwksUrl ?? (await discoverJwksUrl(issuers[0] ?? "")));
    };

    return async (request) => {
        const token = readToken(request);

        if (!token) {
            return ANONYMOUS;
        }

        try {
            const { payload } = await jwtVerify(token, await keySetFor(), {
                algorithms,
                audience: options.audience,
                clockTolerance: options.clockTolerance,
                issuer: issuers.length > 0 ? issuers : undefined,
            });

            return toIdentity(payload, options.claims);
        } catch (error) {
            try {
                options.onError?.(error, request);
            } catch {
                /* an observer must not turn a verification failure into a request error */
            }

            if (error instanceof errors.JWTExpired && error.claim === "exp") {
                return toIdentity(error.payload, options.claims);
            }

            return ANONYMOUS;
        }
    };
};

export type { JwtIdentity, JwtIdentityResolver, JwtIdentityResolverOptions, TokenSource };
export { ANONYMOUS, bearerToken, cookieToken, firstToken, jwtIdentityResolver };
