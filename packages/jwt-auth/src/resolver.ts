import type { JWTPayload } from "jose";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import { withoutExpiryClaims } from "../../../shared/jwt-verify";
import type { JwtVerifierOptions } from "./verify";
import { jwtVerifier, nonEmpty } from "./verify";

/**
 * The identity a resolver hands the runtime. Structurally the same as
 * `@lunora/runtime`'s `ResolvedIdentity` (projected, not imported, so this
 * package carries no runtime dependency): `userId` becomes `ctx.auth.userId`,
 * every other key is forwarded as `ctx.auth.getIdentity()` and read by RLS
 * (`roles` is the claim RLS role checks read).
 */
interface JwtIdentity {
    [claim: string]: unknown;

    /**
     * Token expiry in epoch seconds, plus `clockTolerance`: the runtime has no
     * skew allowance of its own, so a token accepted inside the tolerance must
     * not be refused a second later. A past value makes the runtime answer
     * `TOKEN_EXPIRED` (HTTP 401, socket close 4001).
     */
    exp?: number;
    userId: string;
}

/** Same shape as `WorkerOptions.resolveIdentity`, so the result plugs straight in. */
type JwtIdentityResolver = (request: Request, env?: unknown, context?: ExecutionContextLike) => Promise<JwtIdentity | null>;

/** `resolveIdentity`'s anonymous sentinel (its contract is `… | null`). */
// eslint-disable-next-line unicorn/no-null -- the runtime's resolveIdentity contract value for "anonymous"
const ANONYMOUS = null;

interface JwtIdentityResolverOptions extends JwtVerifierOptions {
    /**
     * Map the verified payload to the extra identity claims (org id, roles,
     * permissions…). Return `null` to treat a verified token as anonymous
     * (e.g. an authorized-party check failed). A returned `userId` overrides
     * the `sub` default. Runs for an expired-but-genuine token too, so such
     * checks hold on that path as well.
     */
    claims?: (payload: JWTPayload) => Record<string, unknown> | null;
}

/** Build the identity from a verified payload, or `null` when the payload names no user or `claims` vetoes it. */
const toIdentity = (payload: JWTPayload, claims: JwtIdentityResolverOptions["claims"], clockTolerance = 0): JwtIdentity | null => {
    const extra = claims ? claims(payload) : {};

    if (extra === null) {
        return ANONYMOUS;
    }

    const userId = nonEmpty(extra.userId) ?? nonEmpty(payload.sub);

    if (userId === undefined) {
        return ANONYMOUS;
    }

    return { ...withoutExpiryClaims(extra), ...(typeof payload.exp === "number" ? { exp: payload.exp + clockTolerance } : {}), userId };
};

/**
 * Create a `resolveIdentity` that verifies a JWT from an external identity
 * provider against its JWKS and maps it to a Lunora identity: `sub` becomes
 * `ctx.auth.userId`, `exp` is forwarded, and `claims` adds whatever else RLS
 * should see.
 *
 * Fail-closed: no token, or a token that fails verification, resolves to
 * `null` (anonymous). The one exception is a token whose ONLY fault is a past
 * `exp` (see {@link jwtVerifier}): it resolves to its identity with that past
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
 * With the default token source the resolver reads only the `Authorization`
 * and `Cookie` headers, so `memoizeIdentity`'s default cache key is safe for
 * it. A custom `token` reading any other header needs a cache key that
 * includes that header.
 */
const jwtIdentityResolver = (options: JwtIdentityResolverOptions): JwtIdentityResolver => {
    const verify = jwtVerifier(options);

    return async (request) => {
        const verified = await verify(request);

        return verified === undefined ? ANONYMOUS : toIdentity(verified.payload, options.claims, options.clockTolerance);
    };
};

export type { JwtIdentity, JwtIdentityResolver, JwtIdentityResolverOptions };
export { ANONYMOUS, jwtIdentityResolver };
