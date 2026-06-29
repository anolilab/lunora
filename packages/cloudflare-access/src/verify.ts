import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { AccessClaims, VerifyAccessJwtOptions } from "./types";

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
        throw new Error('@lunora/cloudflare-access: `teamDomain` is required (e.g. "acme" or "acme.cloudflareaccess.com")');
    }

    const host = trimmed.includes(".") ? trimmed : `${trimmed}.cloudflareaccess.com`;

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
    const keySet = options.keySet ?? remoteJwks(issuer);

    const { payload } = await jwtVerify(token, keySet as Parameters<typeof jwtVerify>[1], {
        algorithms: ["RS256"],
        audience: options.aud,
        clockTolerance: options.clockToleranceSec,
        issuer,
    });

    return payload;
};

export { accessIssuer, verifyAccessJwt };
