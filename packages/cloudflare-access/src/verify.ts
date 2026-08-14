import { LunoraError } from "@lunora/errors";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { DEFAULT_COOKIE, DEFAULT_HEADER, readToken } from "./read-token";
import type { AccessClaims, AccessJwtFallbackOptions, RequestVerifyOptions, VerifyAccessJwtOptions } from "./types";

/** Cloudflare Access publishes its signing keys at this path under the team domain. */
const CERTS_PATH = "/cdn-cgi/access/certs";

/** Leading `http(s)://` scheme, stripped when normalizing a configured team domain. */
const SCHEME_PREFIX = /^https?:\/\//i;

/** Strip trailing `/` characters without a backtracking regex. */
const stripTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

/**
 * Normalize a configured team domain to the canonical Access issuer URL.
 *
 * Accepts a short team name (`acme`), a host (`acme.cloudflareaccess.com`), or a
 * full URL, and always returns an `https://` origin with no trailing slash. A
 * bare name with no dot is expanded to the `cloudflareaccess.com` host.
 */
const accessIssuer = (teamDomain: string): string => {
    const trimmed = stripTrailingSlashes(teamDomain.trim().replace(SCHEME_PREFIX, ""));

    if (trimmed.length === 0) {
        throw new LunoraError("INTERNAL", '@lunora/cloudflare-access: `teamDomain` is required (e.g. "acme" or "acme.cloudflareaccess.com")');
    }

    // A bare name (no dot) is the team subdomain; expand to the full host. Parse
    // through `URL` so a full-URL input keeps only its origin (a stray path like
    // `…/foo` is dropped, not folded into the issuer) and the host is lowercased
    // — hostnames are case-insensitive, so a differently-cased env value must
    // still produce the canonical issuer the `iss` claim is matched against.
    const candidate = trimmed.includes(".") ? `https://${trimmed}` : `https://${trimmed}.cloudflareaccess.com`;
    const host = new URL(candidate).host.toLowerCase();

    return `https://${host}`;
};

/**
 * Cache one remote JWKS getter per issuer for the lifetime of the isolate. The
 * getter itself (from `jose`) holds the fetched keys with a built-in cooldown
 * and refetches on an unknown `kid` (key rotation), so a single instance per
 * issuer is both correct and the recommended usage — re-creating it per request
 * would defeat that cache and hammer the certs endpoint.
 */
const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

const remoteJwks = (issuer: string): JWTVerifyGetKey => {
    let getter = jwksByIssuer.get(issuer);

    if (getter === undefined) {
        getter = createRemoteJWKSet(new URL(`${issuer}${CERTS_PATH}`));
        jwksByIssuer.set(issuer, getter);
    }

    return getter;
};

/**
 * Normalize the configured Access AUD tag(s) to a non-empty list of non-empty
 * strings, throwing when none remain.
 *
 * `aud` is the only claim that scopes a token to *your* Access application — a
 * token minted for any other app in the same team shares the issuer and JWKS.
 * `jose` only enforces audience when a truthy value is passed, so a
 * missing/empty `aud` (a common consequence of an unset `env.CF_ACCESS_AUD`)
 * would silently disable the check and accept cross-app tokens. Refuse without
 * one.
 */
const normalizeAudiences = (aud: VerifyAccessJwtOptions["aud"]): string[] => {
    const audiences = (Array.isArray(aud) ? aud : [aud]).filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

    if (audiences.length === 0) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/cloudflare-access: `aud` is required and must be a non-empty Access AUD tag — refusing to verify a token without an audience to scope it to your application",
        );
    }

    return audiences;
};

/**
 * Eagerly validate the static, construction-time verify options so a misconfigured
 * deployment fails fast at factory build time instead of degrading to
 * silent-anonymous on every request. `createAccessResolver` / `accessAdminGate`
 * call this once when built: `teamDomain` must resolve to a valid Access issuer
 * and `aud` must be a non-empty tag. The per-request catch in {@link verifyRequest}
 * then covers only genuine token-verification failures, not config mistakes — a
 * broken deployment throws here at startup rather than resolving every caller to
 * anonymous with zero signal.
 */
const assertVerifyOptions = (options: VerifyAccessJwtOptions): void => {
    accessIssuer(options.teamDomain);
    normalizeAudiences(options.aud);
};

/**
 * Resolve the optional JWT-verification half of a primitive's config, for the
 * primitives that can also authenticate off the platform-supplied `ctx.access`
 * identity and therefore may legitimately be handed no JWT config at all.
 *
 * Returns a fully-configured verify config when both `teamDomain` and `aud` are
 * supplied, `undefined` when neither key is present at all (run
 * platform-identity-only, with no `Cf-Access-Jwt-Assertion` fallback), and throws
 * otherwise.
 *
 * **Presence of the key is the signal, not its value.** `createAccessResolver()`
 * and `createAccessResolver({ mapClaims })` name neither key and mean "no JWT
 * fallback". `createAccessResolver({ teamDomain: env.CF_ACCESS_TEAM_DOMAIN, aud:
 * env.CF_ACCESS_AUD })` names both and means "verify JWTs" — so when those
 * secrets are unset in some environment and both values arrive `undefined`, that
 * is a broken deployment and it throws, exactly as it did before a missing config
 * became a legal mode. Reading the *values* instead would turn that worker into
 * one that boots happily and resolves every caller to anonymous, with nothing in
 * the logs pointing at Access.
 */
const assertJwtFallbackOptions = (options: AccessJwtFallbackOptions | undefined): RequestVerifyOptions | undefined => {
    if (options === undefined) {
        return undefined;
    }

    if (!("aud" in options) && !("teamDomain" in options)) {
        return undefined;
    }

    const { aud, teamDomain } = options;

    if (aud === undefined || teamDomain === undefined) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/cloudflare-access: `teamDomain` and `aud` must both be set to verify the Cf-Access-Jwt-Assertion JWT (check that CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are set in this environment) — to authenticate only off the Worker's Cloudflare Access identity, omit both options entirely",
        );
    }

    const verifyOptions = { ...options, aud, teamDomain };

    assertVerifyOptions(verifyOptions);

    return verifyOptions;
};

/**
 * Verify a Cloudflare Access JWT and return its claims.
 *
 * Enforces, in one shot: RS256 signature against the team JWKS, `iss` equal to
 * the team issuer, `aud` containing one of the configured Access application AUD
 * tags, and a non-expired `exp` (with optional clock tolerance). The algorithm
 * is pinned to `RS256` so an `alg:none` or HS-signed forgery is rejected
 * outright.
 *
 * Throws (a `jose` error) on any failure — callers that want fail-closed
 * anonymous behaviour should catch and treat it as "no identity" (the
 * `createAccessResolver` adapter does exactly this).
 * @param token The raw compact JWT (header value or cookie value).
 */
const verifyAccessJwt = async (token: string, options: VerifyAccessJwtOptions): Promise<AccessClaims> => {
    const issuer = accessIssuer(options.teamDomain);

    // `aud` scopes the token to *your* Access application; a missing/empty value
    // is refused (see {@link normalizeAudiences}) so a cross-app token can never
    // slip through. The throw is caught by the resolver/admin gate and fails
    // closed.
    const audiences = normalizeAudiences(options.aud);

    const keySet = options.keySet ?? remoteJwks(issuer);

    const { payload } = await jwtVerify(token, keySet as Parameters<typeof jwtVerify>[1], {
        algorithms: ["RS256"],
        audience: audiences,
        clockTolerance: options.clockToleranceSec,
        issuer,
    });

    return payload;
};

/**
 * Read the Access JWT off a request and verify it. Returns the verified claims,
 * or `undefined` when no token is present **or** verification fails — the
 * fail-closed "no Access identity on this request" signal, matching what
 * `readPlatformIdentity` returns for the other authentication path so callers
 * treat the two uniformly.
 *
 * This is the package's one place that turns a *request* into verified claims:
 * header/cookie default resolution, the {@link readToken} read, the
 * {@link verifyAccessJwt} call, and the `onError`-observed fail-closed catch all
 * live here. `onError` fires for a present-but-invalid token, never for an
 * absent one.
 */
const verifyRequest = async (request: Request, options: RequestVerifyOptions): Promise<AccessClaims | undefined> => {
    const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();
    const cookieName = options.cookieName ?? DEFAULT_COOKIE;
    const token = readToken(request, headerName, cookieName);

    if (token === undefined) {
        return undefined;
    }

    try {
        return await verifyAccessJwt(token, options);
    } catch (error) {
        // The observer must not be able to turn a verification failure into a
        // thrown request error — that would break the fail-closed "anonymous on
        // invalid token" contract callers rely on. Swallow anything the hook
        // itself throws; verification still resolves to `undefined` below.
        try {
            options.onError?.(error, request);
        } catch {
            /* ignore observer errors — fail closed regardless */
        }

        return undefined;
    }
};

export { accessIssuer, assertJwtFallbackOptions, assertVerifyOptions, verifyAccessJwt, verifyRequest };
