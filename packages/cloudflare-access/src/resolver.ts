import type { AccessClaims, CreateAccessResolverOptions, ResolvedAccessIdentity, ResolvedIdentityLike, ResolveIdentityFunction } from "./types";
import { verifyRequest } from "./verify";

/**
 * The "anonymous" identity. `null` is the runtime's `resolveIdentity` contract
 * for an unauthenticated caller (its return type is `… | null`); `undefined`
 * would not be assignable. Centralized so the rest of the file stays free of
 * inline `null` literals.
 */
// eslint-disable-next-line unicorn/no-null -- runtime resolveIdentity contract value for "anonymous"
const ANONYMOUS = null;

/**
 * Derive the stable caller id from verified claims: the IdP `sub` for SSO users,
 * falling back to `email`, then `common_name` for service tokens (whose `sub` is
 * empty). Returns `undefined` when none is present — the resolver treats that as
 * anonymous rather than minting an identity with no id.
 */
const deriveUserId = (claims: AccessClaims): string | undefined => {
    const sub = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined;

    return sub ?? claims.email ?? claims.common_name;
};

/**
 * Build the resolved identity from verified claims. Promotes the common Access
 * fields to named keys and carries the full claim set under `access`. `exp`
 * (epoch seconds) is forwarded so the runtime can expire WebSocket sockets.
 */
const toIdentity = (claims: AccessClaims, mapClaims?: CreateAccessResolverOptions["mapClaims"]): ResolvedAccessIdentity | null => {
    const overrides = mapClaims?.(claims) ?? {};
    const userId = typeof overrides.userId === "string" ? overrides.userId : deriveUserId(claims);

    if (userId === undefined) {
        return ANONYMOUS;
    }

    return {
        access: claims,
        ...(claims.common_name === undefined ? {} : { commonName: claims.common_name }),
        ...(claims.email === undefined ? {} : { email: claims.email }),
        ...(claims.exp === undefined ? {} : { exp: claims.exp }),
        ...(claims.groups === undefined ? {} : { groups: claims.groups }),
        ...overrides,
        userId,
    };
};

/**
 * Create a `resolveIdentity` adapter for Cloudflare Access. The returned
 * function reads the Access JWT off the request, verifies it (`verifyAccessJwt`),
 * and maps the claims onto the identity shape `@lunora/runtime` expects — so a
 * verified Access user/service-token becomes `ctx.auth` for every
 * query/mutation/action (and feeds RLS) with no further wiring.
 *
 * Behaviour is **fail-closed → anonymous**: a missing token, or a token that
 * fails verification, resolves to `null` (the request proceeds unauthenticated
 * and RLS denies). Use {@link CreateAccessResolverOptions.onError} to observe
 * verification failures.
 *
 * Wire it in your worker entry:
 *
 * ```ts
 * options.resolveIdentity = createAccessResolver({
 *     teamDomain: env.CF_ACCESS_TEAM_DOMAIN, // "acme" | "acme.cloudflareaccess.com"
 *     aud: env.CF_ACCESS_AUD,                // the Access app's AUD tag
 * });
 * ```
 */
export const createAccessResolver =
    (options: CreateAccessResolverOptions): ResolveIdentityFunction =>
    async (request: Request): Promise<ResolvedAccessIdentity | null> => {
        const claims = await verifyRequest(request, options);

        return claims === undefined ? ANONYMOUS : toIdentity(claims, options.mapClaims);
    };

/**
 * Compose several `resolveIdentity` adapters into one: each is tried in order
 * and the first to return a non-null identity wins. The canonical use is
 * pairing Access with `@lunora/auth` —
 * `composeResolvers(accessResolver, betterAuthResolver)` — so a request carrying
 * an Access JWT (machine/SSO) is authenticated by Access while everyone else
 * falls through to the app's own session.
 */
export const composeResolvers =
    (...resolvers: ResolveIdentityFunction[]): ResolveIdentityFunction =>
    async (request: Request, env?: unknown): Promise<ResolvedIdentityLike | null> => {
        for (const resolve of resolvers) {
            // eslint-disable-next-line no-await-in-loop -- ordered fallback: each resolver may early-return, so they cannot run concurrently
            const identity = await resolve(request, env);

            if (identity) {
                return identity;
            }
        }

        return ANONYMOUS;
    };
