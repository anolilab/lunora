import { LunoraError } from "@lunora/errors";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { DEFAULT_COOKIE, DEFAULT_HEADER, readToken } from "./read-token";
import type { AccessClaims, RequestVerifyOptions, VerifyAccessJwtOptions } from "./types";

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

    // `aud` is the only claim that scopes a token to *your* Access application —
    // a token minted for any other app in the same team shares the issuer and
    // JWKS. `jose` only enforces audience when a truthy value is passed, so a
    // missing/empty `aud` (a common consequence of an unset `env.CF_ACCESS_AUD`)
    // would silently disable the check and accept cross-app tokens. Refuse to
    // verify without one; the throw is caught by the resolver/admin gate and
    // fails closed.
    const audiences = (Array.isArray(options.aud) ? options.aud : [options.aud]).filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );

    if (audiences.length === 0) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/cloudflare-access: `aud` is required and must be a non-empty Access AUD tag — refusing to verify a token without an audience to scope it to your application",
        );
    }

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
 * or `undefined` when no token is present **or** verification fails — the single
 * fail-closed "no Access identity" signal that both `createAccessResolver` and
 * `accessAdminGate` build their distinct mapping / authorization step on top of.
 *
 * This is the package's one place that turns a request into verified claims:
 * header/cookie default resolution, the {@link readToken} read, the
 * {@link verifyAccessJwt} call, and the `onError`-observed fail-closed catch all
 * live here so the resolver and the admin gate carry only their genuinely
 * distinct line. `onError` fires for a present-but-invalid token, never for an
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

export { accessIssuer, verifyAccessJwt, verifyRequest };
