import type { JWTPayload, JWTVerifyGetKey, KeyObject } from "jose";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { AccessRoleMap } from "./identity-groups";

/**
 * The verified claims of a Cloudflare Access caller — from the
 * `Cf-Access-Jwt-Assertion` JWT (hostname-scoped Access applications) or from the
 * platform-supplied `ctx.access.getIdentity()` (Access policies attached to the
 * Worker). Both paths produce this one shape, so nothing downstream branches on
 * how the caller was authenticated.
 *
 * Extends the standard `JWTPayload` (`iss`/`aud`/`sub`/`exp`/`iat`/…) with the
 * Access-specific fields. Which optional fields are present depends on the
 * caller and the Access application config. SSO users carry `email` (and
 * `groups` when the policy emits them), with `sub` as the stable user id.
 * Service tokens carry `common_name` and an empty `sub`; there is no `email`.
 *
 * Cloudflare may add further custom claims — they pass through verbatim via the
 * index signature so the claims stay a faithful view of the identity.
 */
export interface AccessClaims extends JWTPayload {
    /** Service-token name. Present for non-interactive (machine) callers instead of `email`. */
    common_name?: string;
    /** ISO-3166-1 alpha-2 country the request was authorized from, when available. */
    country?: string;
    /** Verified user email. Present for interactive (SSO) callers. */
    email?: string;
    /** Identity-provider group memberships, when the Access policy is configured to emit them. */
    groups?: string[];
    /** Per-session nonce Cloudflare rotates on re-authentication. */
    identity_nonce?: string;
    /** Display name from the identity provider. Populated on the platform-supplied identity, not on the JWT. */
    name?: string;
    /** Token kind, e.g. `"app"`. */
    type?: string;
    /** Cloudflare's per-user UUID. Populated on the platform-supplied identity, not on the JWT — so `userId` is deliberately never derived from it. */
    user_uuid?: string;
}

/**
 * The minimal `resolveIdentity` return contract shared with `@lunora/runtime`'s
 * `WorkerOptions.resolveIdentity` (`ResolvedIdentity`). Declared structurally so
 * this package takes no runtime dependency on `@lunora/runtime`; the value is
 * assignable to the runtime hook.
 *
 * `userId` becomes `ctx.auth.userId`; every other key is forwarded (server-side,
 * unforgeable) into `x-lunora-identity` and surfaced via `ctx.auth.getIdentity()`.
 * `exp` (JWT epoch **seconds**) drives WebSocket credential expiry — omit it and
 * a live subscription socket never expires.
 */
export interface ResolvedIdentityLike {
    /** All other claims pass through into `ctx.auth.getIdentity()`. */
    [claim: string]: unknown;
    /** JWT `exp` in epoch **seconds** (NOT milliseconds). Drives WS socket expiry. */
    exp?: number;
    /** Absolute expiry in epoch **milliseconds**. Alternative to `exp`; takes precedence in the runtime. */
    expiresAtMs?: number;
    /** The stable caller id. Becomes `ctx.auth.userId` and what `serverDefault(({auth}) => auth.userId)` stamps. */
    userId: string;
}

/**
 * The verified Access identity produced by `createAccessResolver`. A
 * {@link ResolvedIdentityLike} with the commonly-used Access claims promoted to
 * named, camelCased fields (so policies read `auth.identity.groups` etc.) plus
 * the full raw claim set under `access` for fidelity.
 */
export interface ResolvedAccessIdentity extends ResolvedIdentityLike {
    /** The full, verified claim set (snake_cased wire names preserved). */
    access: AccessClaims;
    /** Service-token name (`common_name`), for machine callers. */
    commonName?: string;
    /** Verified email, for SSO callers. */
    email?: string;
    /** IdP group memberships, when emitted by the Access policy. */
    groups?: string[];
}

/**
 * A key source for `verifyAccessJwt`. Either a `jose` remote/local JWKS getter,
 * or a single public key (handy for tests that mint their own RS256 tokens).
 * When omitted, a cached remote JWKS is built from `teamDomain`.
 */
export type AccessKeySet = CryptoKey | JWTVerifyGetKey | KeyObject | Uint8Array;

/** Options for `verifyAccessJwt`. */
export interface VerifyAccessJwtOptions {
    /**
     * The Access application **AUD tag(s)** (the application audience from the
     * Access app's Overview). Verification rejects a token whose `aud` does not
     * include one of these — this is what scopes a token to *your* app.
     */
    aud: string | string[];
    /** Clock-skew tolerance in **seconds** applied to `exp`/`nbf`/`iat`. Default `0`. */
    clockToleranceSec?: number;

    /**
     * Override the verification key source. Primarily for tests; in production
     * leave unset to use the cached remote JWKS derived from `teamDomain`.
     */
    keySet?: AccessKeySet;

    /**
     * Your Cloudflare Access team domain. Accepts the short team name (`acme`),
     * the host (`acme.cloudflareaccess.com`), or a full URL
     * (`https://acme.cloudflareaccess.com`). Determines both the expected issuer
     * and the JWKS endpoint.
     */
    teamDomain: string;
}

/**
 * Common options for the request-driven Access primitives — how to read the JWT
 * off the request and what to do when verification fails. Shared by
 * {@link CreateAccessResolverOptions} and `AccessAdminGateOptions`, which add
 * their distinct mapping / authorization step on top.
 */
export interface RequestVerifyOptions extends VerifyAccessJwtOptions {
    /**
     * Cookie name carrying the Access JWT when the header is absent (browser
     * navigations). Default `"CF_Authorization"`.
     */
    cookieName?: string;

    /**
     * Request header carrying the Access JWT. Default `"cf-access-jwt-assertion"`
     * (matched case-insensitively).
     */
    headerName?: string;

    /**
     * Invoked when a token is present but fails verification (bad signature,
     * wrong audience, expired, …). The caller still fails closed (resolver
     * returns `null`, admin gate returns `false`); this is your hook to
     * log/observe. It is **not** called when no token is present at all.
     */
    onError?: (error: unknown, request: Request) => void;
}

/**
 * {@link RequestVerifyOptions} with the JWT-verification config made optional,
 * for the primitives that can also authenticate off the platform-supplied
 * identity (`ctx.access`) and therefore may legitimately be given no JWT config
 * at all.
 *
 * The two fields are **all-or-nothing**: supply both to enable the
 * `Cf-Access-Jwt-Assertion` fallback (needed for hostname-scoped Access
 * applications, which do not populate `ctx.access`), or neither to run
 * platform-identity-only. Supplying exactly one throws at construction — that is
 * always a misconfiguration (classically an unset `env.CF_ACCESS_AUD`), and
 * silently degrading it to "no JWT fallback" would turn a broken deployment into
 * a quietly anonymous one.
 */
export interface AccessJwtFallbackOptions extends Omit<RequestVerifyOptions, "aud" | "teamDomain"> {
    /**
     * The Access application **AUD tag(s)**. Required together with `teamDomain`
     * to enable JWT verification; omit both to authenticate only off the
     * platform-supplied identity.
     */
    aud?: string | string[];

    /**
     * Your Cloudflare Access team domain. Required together with `aud` to enable
     * JWT verification; omit both to authenticate only off the platform-supplied
     * identity.
     */
    teamDomain?: string;
}

/** Options for `createAccessResolver`; extends {@link AccessJwtFallbackOptions}. */
export interface CreateAccessResolverOptions extends AccessJwtFallbackOptions {
    /**
     * Remap verified claims into the resolved identity. Return an object to
     * shallow-merge over the defaults; return a `userId` to override the derived
     * caller id. Runs only after signature/issuer/audience/expiry are verified.
     *
     * It is merged OVER the `roles` claim {@link CreateAccessResolverOptions.roles}
     * mints, so returning `roles` here replaces the mapped set outright.
     */
    mapClaims?: (claims: AccessClaims) => Record<string, unknown>;

    /**
     * Map the verified Access `groups` claim onto RLS role names, minted as the
     * identity's `roles` claim — the list `rls()` unions permissions over.
     *
     * A table (`{ "idp-admins": "admin", "idp-eng": ["editor", "viewer"] }`) or a
     * function; either may return one role, an array, or `undefined` to drop the
     * group. Omit the option and no `roles` claim is minted at all — granting
     * every group name as a role by default would hand existing deployments
     * permissions their policies never intended. Pass `(group) => group` to opt
     * into group names as role names verbatim.
     *
     * Roles live ON THE IDENTITY rather than being derived per-procedure so that
     * every consumer sees the same set. A middleware that writes `ctx.auth.roles`
     * reaches queries and mutations but NOT live shapes — a shape runs no
     * procedure, so no middleware fires — and a role-gated policy then resolves
     * differently for a query and the subscription that mirrors it. The identity
     * is the one place both paths read.
     */
    roles?: AccessRoleMap;
}

/**
 * A `resolveIdentity`-shaped function: maps an inbound request to a verified
 * identity (or `null` for anonymous). Assignable to `@lunora/runtime`'s
 * `WorkerOptions.resolveIdentity`.
 *
 * The third argument is the request's `ExecutionContext`, which the runtime
 * forwards so a resolver can read the identity Cloudflare Access attaches to a
 * Worker-protected request (`context.access`). It is `undefined` on paths that
 * have no context to give, so a resolver must handle its absence.
 */
export type ResolveIdentityFunction = (
    request: Request,
    env?: unknown,
    context?: ExecutionContextLike,
) => (ResolvedIdentityLike | null) | Promise<ResolvedIdentityLike | null>;
