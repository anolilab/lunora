import { LunoraError } from "@lunora/errors";
import type { JWTPayload } from "jose";

import type { JwtIdentityResolver, JwtIdentityResolverOptions } from "./resolver";
import { ANONYMOUS, bearerToken, cookieToken, firstToken, jwtIdentityResolver } from "./resolver";

const SCHEME = /^https?:\/\//iu;
const PUBLISHABLE_KEY = /^pk_(?:test|live)_(.+)$/u;
const ORG_PREFIX = /^org:/u;

const nonEmptyString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** What a preset still lets the caller tune: everything but the provider-fixed issuer / key set / algorithms. */
type PresetOverrides = Pick<JwtIdentityResolverOptions, "claims" | "clockTolerance" | "keySet" | "onError" | "token">;

const stringList = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
        const list = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

        return list.length > 0 ? list : undefined;
    }

    return typeof value === "string" && value.length > 0 ? [value] : undefined;
};

/** Drop `undefined` values so the forwarded identity carries only claims the token actually had. */
const defined = (claims: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));

/** Layer the caller's `claims` mapper over a preset's, preset first; either can veto with `null`. */
const withExtraClaims =
    (base: (payload: JWTPayload) => Record<string, unknown> | null, extra: PresetOverrides["claims"]) =>
    (payload: JWTPayload): Record<string, unknown> | null => {
        const mapped = base(payload);

        if (mapped === null || extra === undefined) {
            return mapped;
        }

        const more = extra(payload);

        return more === null ? ANONYMOUS : { ...mapped, ...more };
    };

const httpsOrigin = (value: string, name: string): string => {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
        throw new LunoraError("INTERNAL", `@lunora/jwt-auth: \`${name}\` is empty — check that the env var holding it is set`);
    }

    return new URL(SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`).origin;
};

// ---------------------------------------------------------------------------
// Clerk
// ---------------------------------------------------------------------------

interface ClerkOptions extends PresetOverrides {
    /**
     * Origins allowed in the token's `azp` claim (the `Origin` of the browser
     * request that minted it), e.g. `["https://app.example.com"]`. Clerk
     * "highly recommend[s]" this check; a token without `azp` passes it.
     * https://clerk.com/docs/guides/sessions/manual-jwt-verification
     */
    authorizedParties?: string[];

    /** Your Frontend API URL (the session token's `iss`), e.g. `https://clerk.example.com` or `https://<slug>.clerk.accounts.dev`. */
    issuer?: string;

    /** Alternatively, the publishable key (`pk_test_…` / `pk_live_…`), which encodes the Frontend API host. */
    publishableKey?: string;
}

/**
 * Decode a Clerk publishable key to its Frontend API URL. The key is
 * `pk_(test|live)_` + base64(`<frontend-api-host>$`); Clerk's own derivation is
 * `atob(key.split('_')[2]).slice(0, -1)`.
 * @see https://clerk.com/docs/js-frontend/getting-started/quickstart
 */
const clerkFrontendApi = (publishableKey: string): string => {
    const encoded = PUBLISHABLE_KEY.exec(publishableKey.trim())?.[1];
    let decoded = "";

    try {
        decoded = encoded === undefined ? "" : atob(encoded);
    } catch {
        /* reported below */
    }

    if (!decoded.endsWith("$")) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: `publishableKey` is not a Clerk publishable key (pk_test_… / pk_live_…)");
    }

    return `https://${decoded.slice(0, -1)}`;
};

/**
 * Map Clerk session-token claims (v2 with a v1 fallback) to identity claims.
 *
 * v2 nests the active organization under `o`: `o.id`, `o.slg`, `o.rol` (role
 * WITHOUT the `org:` prefix) and `o.per` (comma-separated permission names);
 * v1 used top-level `org_id` / `org_slug` / `org_role` (`org:admin`) /
 * `org_permissions`. `sts: "pending"` marks a session that has not finished a
 * required step (e.g. choosing an organization) and is treated as anonymous.
 * @see https://clerk.com/docs/guides/sessions/session-tokens
 */
const clerkClaims =
    (authorizedParties: string[] | undefined) =>
    (payload: JWTPayload): Record<string, unknown> | null => {
        if (payload.sts === "pending") {
            return ANONYMOUS;
        }

        if (authorizedParties !== undefined && typeof payload.azp === "string" && !authorizedParties.includes(payload.azp)) {
            return ANONYMOUS;
        }

        const org = (typeof payload.o === "object" && payload.o !== null ? payload.o : {}) as Record<string, unknown>;
        const v1Role = typeof payload.org_role === "string" ? payload.org_role.replace(ORG_PREFIX, "") : undefined;
        const orgRole = nonEmptyString(org.rol) ?? v1Role;
        const permissions = typeof org.per === "string" ? org.per.split(",").filter(Boolean) : stringList(payload.org_permissions);

        return defined({
            orgId: nonEmptyString(org.id) ?? nonEmptyString(payload.org_id),
            orgPermissions: permissions,
            orgRole,
            orgSlug: nonEmptyString(org.slg) ?? nonEmptyString(payload.org_slug),
            roles: orgRole === undefined ? undefined : [orgRole],
            sessionId: nonEmptyString(payload.sid),
        });
    };

/**
 * Clerk session tokens. JWKS at `<Frontend API>/.well-known/jwks.json`, `iss`
 * is the Frontend API URL, RS256, no `aud` (Clerk scopes with `azp` instead —
 * pass `authorizedParties`). The token is read from `Authorization: Bearer`
 * (cross-origin, per Clerk) and falls back to the `__session` cookie Clerk sets
 * on your domain for same-origin requests.
 * @see https://clerk.com/docs/guides/sessions/manual-jwt-verification
 * @see https://clerk.com/docs/guides/development/making-requests
 *
 * Identity claims: `orgId`, `orgSlug`, `orgRole` (e.g. `admin`),
 * `orgPermissions` (bare names, e.g. `["read", "manage"]`), `roles`
 * (`[orgRole]`, for RLS), `sessionId`.
 */
const clerk = (options: ClerkOptions): JwtIdentityResolver => {
    const issuer = options.issuer === undefined ? clerkFrontendApi(options.publishableKey ?? "") : httpsOrigin(options.issuer, "issuer");

    return jwtIdentityResolver({
        ...options,
        algorithms: ["RS256"],
        claims: withExtraClaims(clerkClaims(options.authorizedParties), options.claims),
        issuer,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        token: options.token ?? firstToken(bearerToken, cookieToken("__session")),
    });
};

// ---------------------------------------------------------------------------
// WorkOS AuthKit
// ---------------------------------------------------------------------------

interface WorkOsOptions extends PresetOverrides {
    /** Your custom auth domain when one is configured (it then replaces `https://api.workos.com` as `iss`). */
    authDomain?: string;

    /** The WorkOS client id (`client_…`) — names the JWKS and must match the token's `client_id`. */
    clientId: string;
}

/**
 * WorkOS AuthKit access tokens. JWKS at
 * `https://api.workos.com/sso/jwks/<clientId>`; `iss` is `https://api.workos.com/`
 * (or your custom auth domain). WorkOS's docs show it both with and without the
 * trailing slash, so both are accepted. There is no `aud`; the token's
 * `client_id` is checked against `clientId` instead.
 * @see https://workos.com/docs/authkit/sessions
 * @see https://workos.com/docs/reference/authkit/session-tokens
 *
 * `authkit-react` keeps the access token in memory (the refresh token is an
 * HttpOnly cookie on the auth domain), so it reaches the API only as
 * `Authorization: Bearer` — the default token source here.
 *
 * Identity claims: `orgId`, `role`, `roles` (the `roles` array, else
 * `[role]`, for RLS), `permissions`, `entitlements`, `featureFlags`,
 * `sessionId`, and `impersonator` when an admin is impersonating the user.
 */
const workos = (options: WorkOsOptions): JwtIdentityResolver => {
    const clientId = options.clientId.trim();

    if (clientId.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: `clientId` is empty — check that WORKOS_CLIENT_ID is set");
    }

    const origin = options.authDomain === undefined ? "https://api.workos.com" : httpsOrigin(options.authDomain, "authDomain");

    const workosClaims = (payload: JWTPayload): Record<string, unknown> | null => {
        if (payload.client_id !== undefined && payload.client_id !== clientId) {
            return ANONYMOUS;
        }

        const role = nonEmptyString(payload.role);
        const actor = payload.act as { sub?: unknown } | undefined;

        return defined({
            entitlements: stringList(payload.entitlements),
            featureFlags: stringList(payload.feature_flags),
            impersonator: nonEmptyString(actor?.sub),
            orgId: nonEmptyString(payload.org_id),
            permissions: stringList(payload.permissions),
            role,
            roles: stringList(payload.roles) ?? (role === undefined ? undefined : [role]),
            sessionId: nonEmptyString(payload.sid),
        });
    };

    return jwtIdentityResolver({
        ...options,
        algorithms: ["RS256"],
        claims: withExtraClaims(workosClaims, options.claims),
        issuer: [origin, `${origin}/`],
        jwksUrl: `https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`,
    });
};

// ---------------------------------------------------------------------------
// Auth0
// ---------------------------------------------------------------------------

interface Auth0Options extends PresetOverrides {
    /** Your API's identifier — the access token's `aud`. Required: it is what scopes a token to your API. */
    audience: string;

    /** Your Auth0 domain, e.g. `acme.us.auth0.com` or a custom domain. */
    domain: string;
}

/**
 * Auth0 access tokens. JWKS at `https://<domain>/.well-known/jwks.json`, `iss`
 * is `https://<domain>/` (trailing slash), `aud` is your API identifier, RS256.
 * Forwards `permissions` (RBAC "Add Permissions in the Access Token") and
 * `orgId` (`org_id`, Organizations).
 * @see https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens
 * @see https://auth0.com/docs/get-started/apis/enable-role-based-access-control-for-apis
 * @see https://auth0.com/docs/manage-users/organizations/using-tokens
 */
const auth0 = (options: Auth0Options): JwtIdentityResolver => {
    const origin = httpsOrigin(options.domain, "domain");

    if (options.audience.trim().length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: `audience` is empty — set it to your Auth0 API identifier");
    }

    return jwtIdentityResolver({
        ...options,
        algorithms: ["RS256"],
        audience: options.audience,
        claims: withExtraClaims((payload) => defined({ orgId: nonEmptyString(payload.org_id), permissions: stringList(payload.permissions) }), options.claims),
        issuer: `${origin}/`,
        jwksUrl: `${origin}/.well-known/jwks.json`,
    });
};

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------

interface SupabaseOptions extends PresetOverrides {
    /** Your project URL, e.g. `https://<project-ref>.supabase.co`. */
    projectUrl: string;
}

/**
 * Supabase Auth user tokens signed with asymmetric keys (ES256 / RS256; the
 * legacy HS256 secret has no public key and cannot be verified this way). JWKS
 * at `<project>/auth/v1/.well-known/jwks.json`, `iss` is `<project>/auth/v1`,
 * `aud` is `authenticated` (anonymous-user tokens are `anon` and so stay
 * anonymous here). Forwards `email`, `role` (the Postgres role), `aal`,
 * `isAnonymous` and `sessionId`.
 * @see https://supabase.com/docs/guides/auth/signing-keys
 * @see https://supabase.com/docs/guides/auth/jwt-fields
 */
const supabase = (options: SupabaseOptions): JwtIdentityResolver => {
    const origin = httpsOrigin(options.projectUrl, "projectUrl");

    return jwtIdentityResolver({
        ...options,
        algorithms: ["ES256", "RS256"],
        audience: "authenticated",
        claims: withExtraClaims(
            (payload) =>
                defined({
                    aal: nonEmptyString(payload.aal),
                    email: nonEmptyString(payload.email),
                    isAnonymous: typeof payload.is_anonymous === "boolean" ? payload.is_anonymous : undefined,
                    role: nonEmptyString(payload.role),
                    sessionId: nonEmptyString(payload.session_id),
                }),
            options.claims,
        ),
        issuer: `${origin}/auth/v1`,
        jwksUrl: `${origin}/auth/v1/.well-known/jwks.json`,
    });
};

export type { Auth0Options, ClerkOptions, SupabaseOptions, WorkOsOptions };
export { auth0, clerk, supabase, workos };
