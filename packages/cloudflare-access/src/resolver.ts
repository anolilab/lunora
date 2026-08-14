import type { ExecutionContextLike } from "../../../shared/execution-context";
import readPlatformIdentity from "./platform-identity";
import type { AccessClaims, CreateAccessResolverOptions, ResolvedAccessIdentity, ResolvedIdentityLike, ResolveIdentityFunction } from "./types";
import { assertJwtFallbackOptions, verifyRequest } from "./verify";

/**
 * The "anonymous" identity. `null` is the runtime's `resolveIdentity` contract
 * for an unauthenticated caller (its return type is `… | null`); `undefined`
 * would not be assignable. Centralized so the rest of the file stays free of
 * inline `null` literals.
 */
// eslint-disable-next-line unicorn/no-null -- runtime resolveIdentity contract value for "anonymous"
const ANONYMOUS = null;

/**
 * Narrow a claim to a non-empty string. `""` (and any non-string / nullish value)
 * is treated as absent, so an empty `email` / `common_name` / `mapClaims.userId`
 * never mints an identity whose `userId` is the empty string — every such caller
 * would otherwise collide on one shared id and RLS ownership defaults would stamp
 * rows with `""`.
 */
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/**
 * Derive the stable caller id from verified claims: the IdP `sub` for SSO users,
 * falling back to `email`, then `common_name` for service tokens (whose `sub` is
 * empty). Returns `undefined` when none is present — the resolver treats that as
 * anonymous rather than minting an identity with no id.
 *
 * Deliberately identical for both authentication paths, and deliberately does NOT
 * consider `user_uuid` even though the platform-supplied identity carries one:
 * `userId` is the ownership key RLS and `serverDefault` columns are stamped with,
 * so a deployment that moves from a hostname-scoped Access application to a
 * Worker-scoped policy must keep resolving each user to the same id. Preferring a
 * field only one path emits would silently re-key every user on that switch,
 * orphaning their existing rows behind RLS.
 */
const deriveUserId = (claims: AccessClaims): string | undefined => nonEmpty(claims.sub) ?? nonEmpty(claims.email) ?? nonEmpty(claims.common_name);

/**
 * Build the resolved identity from verified claims. Promotes the common Access
 * fields to named keys and carries the full claim set under `access`. `exp`
 * (epoch seconds) is forwarded so the runtime can expire WebSocket sockets.
 */
const toIdentity = (claims: AccessClaims, mapClaims?: CreateAccessResolverOptions["mapClaims"]): ResolvedAccessIdentity | null => {
    const overrides = mapClaims?.(claims) ?? {};
    const userId = nonEmpty(overrides.userId) ?? deriveUserId(claims);

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
 * Create a `resolveIdentity` adapter for Cloudflare Access, so a verified Access
 * user or service token becomes `ctx.auth` for every query/mutation/action (and
 * feeds RLS) with no further wiring.
 *
 * It authenticates from whichever of the two Access shapes the deployment uses,
 * **platform identity first**:
 *
 * 1. `context.access` — the identity Cloudflare attaches when the Access policy
 * is attached to the **Worker** (covering its custom domains, routes,
 * `workers.dev`, and preview URLs at once). Nothing is verified because nothing
 * can be forged: the platform authenticated the caller before the Worker ran,
 * and the field is absent unless it did. No JWKS fetch, no `aud` to get wrong.
 * This is also what `wrangler.jsonc`'s `access.dev` block simulates, so a
 * locally-simulated identity reaches `ctx.auth` too.
 * 2. The `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie),
 * verified against your team JWKS. Needed for **hostname-scoped** Access
 * applications, which do not populate `context.access`. Configured by passing
 * `teamDomain` + `aud`; omit both (or pass no options at all) to run
 * platform-identity-only.
 *
 * Behaviour is **fail-closed → anonymous** on both paths: no identity, or a token
 * that fails verification, resolves to `null` (the request proceeds
 * unauthenticated and RLS denies). Use {@link CreateAccessResolverOptions.onError}
 * to observe verification failures.
 *
 * Wire it in your worker entry:
 *
 * ```ts
 * // Access policy attached to the Worker — nothing to configure.
 * options.resolveIdentity = createAccessResolver();
 *
 * // Hostname-scoped Access application — JWT verification config required.
 * options.resolveIdentity = createAccessResolver({
 *     teamDomain: env.CF_ACCESS_TEAM_DOMAIN, // "acme" | "acme.cloudflareaccess.com"
 *     aud: env.CF_ACCESS_AUD,                // the Access app's AUD tag
 * });
 * ```
 */
export const createAccessResolver = (options?: CreateAccessResolverOptions): ResolveIdentityFunction => {
    // Validate the static config eagerly so a half-configured deployment (an unset
    // CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD) fails fast here at wiring time
    // instead of degrading to silent-anonymous — and thus RLS-denied — on every
    // request with no signal. `undefined` means "no JWT fallback", which is a
    // legal mode only when the caller named neither option.
    const jwtOptions = assertJwtFallbackOptions(options);

    return async (request: Request, _env?: unknown, context?: ExecutionContextLike): Promise<ResolvedAccessIdentity | null> => {
        // Platform identity wins when present: it is the stronger of the two
        // (authenticated by the edge, unforgeable, nothing to re-verify), and on a
        // Worker-scoped Access deployment it is the only one that exists. Both
        // paths fail closed to `undefined`.
        const claims = (await readPlatformIdentity(context)) ?? (jwtOptions === undefined ? undefined : await verifyRequest(request, jwtOptions));

        return claims === undefined ? ANONYMOUS : toIdentity(claims, options?.mapClaims);
    };
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
    async (request: Request, env?: unknown, context?: ExecutionContextLike): Promise<ResolvedIdentityLike | null> => {
        for (const resolve of resolvers) {
            // eslint-disable-next-line no-await-in-loop -- ordered fallback: each resolver may early-return, so they cannot run concurrently
            const identity = await resolve(request, env, context);

            if (identity) {
                return identity;
            }
        }

        return ANONYMOUS;
    };
