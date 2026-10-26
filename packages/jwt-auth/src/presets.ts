import { LunoraError } from "@lunora/errors";
import type { JWTPayload } from "jose";

import type { JwtIdentityResolver, JwtIdentityResolverOptions } from "./resolver";
import { ANONYMOUS, jwtIdentityResolver } from "./resolver";
import { bearerToken, cookieToken, firstToken, httpsOrigin, nonEmpty } from "./verify";

const PUBLISHABLE_KEY = /^pk_(?:test|live)_(.+)$/u;
const WHITESPACE = /\s+/u;
const SCHEME = /^https?:\/\//iu;

/** What a preset still lets the caller tune: everything but the provider-fixed issuer / key set / algorithms. */
type PresetOverrides = Pick<JwtIdentityResolverOptions, "claims" | "clockTolerance" | "keySet" | "onError" | "token">;

type ClaimsMapper = (payload: JWTPayload) => Record<string, unknown> | null;

const stringList = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
        const list = value.filter((entry): entry is string => nonEmpty(entry) !== undefined);

        return list.length > 0 ? list : undefined;
    }

    return nonEmpty(value) === undefined ? undefined : [value as string];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Drop `undefined` values so the forwarded identity carries only claims the token actually had. */
const defined = (claims: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));

/** Layer the caller's `claims` mapper over a preset's, preset first; either can veto with `null`. */
const withExtraClaims =
    (base: ClaimsMapper, extra: PresetOverrides["claims"]): ClaimsMapper =>
    (payload) => {
        const mapped = base(payload);

        if (mapped === null || extra === undefined) {
            return mapped;
        }

        const more = extra(payload);

        return more === null ? ANONYMOUS : { ...mapped, ...more };
    };

/**
 * Build a preset's resolver from the provider-fixed settings and the caller's
 * {@link PresetOverrides}, picked by name so a provider-only option
 * (`authorizedParties`, `clientId`…) never reaches the resolver.
 */
const presetResolver = (
    overrides: PresetOverrides,
    preset: Pick<JwtIdentityResolverOptions, "algorithms" | "audience" | "clockTolerance" | "issuer" | "jwksUrl" | "token"> & { claims: ClaimsMapper },
): JwtIdentityResolver =>
    jwtIdentityResolver({
        algorithms: preset.algorithms,
        audience: preset.audience,
        claims: withExtraClaims(preset.claims, overrides.claims),
        clockTolerance: overrides.clockTolerance ?? preset.clockTolerance,
        issuer: preset.issuer,
        jwksUrl: preset.jwksUrl,
        keySet: overrides.keySet,
        onError: overrides.onError,
        token: overrides.token ?? preset.token,
    });

// ---------------------------------------------------------------------------
// Clerk
// ---------------------------------------------------------------------------

interface ClerkOptions extends PresetOverrides {
    /**
     * Origins allowed in the token's `azp` claim (the `Origin` of the browser
     * request that minted it), e.g. `["https://app.example.com"]`, or the same
     * list comma-separated (as an env var holds it). Required:
     * Clerk warns that skipping this check "can open your application to CSRF
     * attacks". A token without `azp` (a native app's) passes, as Clerk's manual
     * verification guide prescribes.
     * @see https://clerk.com/docs/guides/sessions/manual-jwt-verification
     */
    authorizedParties: string | string[];

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
    if (publishableKey.trim().length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: set `issuer` or `publishableKey` — check that CLERK_PUBLISHABLE_KEY is set");
    }

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

const CLERK_MASK = /^\d+$/u;

/** Scopes whose features carry organization permissions; `ou` / `uo` are both user and org (`splitByScope` in `@clerk/shared`). */
const CLERK_ORG_SCOPES = new Set(["o", "ou", "uo"]);

/**
 * Decode Clerk v2's compact organization permissions into full permission keys
 * (`org:<feature>:<permission>`, the same format as v1's `org_permissions`),
 * matching `@clerk/shared`'s `jwtPayloadParser` + `splitByScope`.
 *
 * `fea` lists features with their scope (`u:beta,o:dashboard`). Only the
 * organization-scoped ones (`o:`, `ou:`, `uo:`) are kept, in order; `o.fpm`
 * holds one integer per KEPT feature, a bitmask over `o.per` whose least
 * significant bit is the first `per` entry. Clerk's example: `fea:
 * "o:dashboard,o:teams"`, `per: "manage,read"`, `fpm: "3,2"` grants
 * `dashboard:manage`, `dashboard:read` and `teams:read`. Entries are trimmed.
 * Anything malformed (a missing claim, an entry without a scope, a mask count
 * that does not match the org features, a non-integer mask) forwards nothing.
 * @see https://clerk.com/docs/guides/sessions/session-tokens
 * @see https://github.com/clerk/javascript/blob/main/packages/shared/src/jwtPayloadParser.ts
 */
const clerkV2Permissions = (fea: unknown, org: Record<string, unknown>): string[] | undefined => {
    if (typeof fea !== "string" || typeof org.per !== "string" || typeof org.fpm !== "string") {
        return undefined;
    }

    const features: string[] = [];

    for (const entry of fea.split(",")) {
        const scoped = entry.trim();
        const colon = scoped.indexOf(":");

        if (colon === -1) {
            return undefined;
        }

        if (CLERK_ORG_SCOPES.has(scoped.slice(0, colon))) {
            features.push(scoped.slice(colon + 1));
        }
    }

    const permissionNames = org.per.split(",").map((name) => name.trim());
    const masks = org.fpm.split(",").map((mask) => mask.trim());

    if (features.length !== masks.length || masks.some((mask) => !CLERK_MASK.test(mask))) {
        return undefined;
    }

    const granted: string[] = [];

    for (const [index, feature] of features.entries()) {
        // Read right to left: the last binary digit is the bit for the first `per` entry.
        const binary = BigInt(masks[index] as string).toString(2);

        for (const [bit, name] of permissionNames.entries()) {
            if (name.length > 0 && binary.at(-1 - bit) === "1") {
                granted.push(`org:${feature}:${name}`);
            }
        }
    }

    return granted;
};

/**
 * Map Clerk session-token claims to identity claims. `v: 2` nests the active
 * organization under `o` (`o.id`, `o.slg`, `o.rol` without the `org:` prefix)
 * with compact permissions ({@link clerkV2Permissions}); anything else is read
 * as v1's top-level `org_id` / `org_slug` / `org_role` / `org_permissions`.
 * `sts: "pending"` marks a session that has not finished a required step (e.g.
 * choosing an organization) and is treated as anonymous.
 * @see https://clerk.com/docs/guides/sessions/session-tokens
 */
const clerkClaims =
    (authorizedParties: string[]): ClaimsMapper =>
    (payload) => {
        if (payload.sts === "pending") {
            return ANONYMOUS;
        }

        if (typeof payload.azp === "string" && !authorizedParties.includes(payload.azp)) {
            return ANONYMOUS;
        }

        if (payload.v === 2) {
            const org = isRecord(payload.o) ? payload.o : undefined;
            const role = nonEmpty(org?.rol);

            return defined({
                orgId: nonEmpty(org?.id),
                orgPermissions: org === undefined ? undefined : clerkV2Permissions(payload.fea, org),
                orgRole: role === undefined ? undefined : `org:${role}`,
                orgSlug: nonEmpty(org?.slg),
                sessionId: nonEmpty(payload.sid),
            });
        }

        return defined({
            orgId: nonEmpty(payload.org_id),
            orgPermissions: stringList(payload.org_permissions),
            orgRole: nonEmpty(payload.org_role),
            orgSlug: nonEmpty(payload.org_slug),
            sessionId: nonEmpty(payload.sid),
        });
    };

/**
 * Clerk session tokens. JWKS at `<Frontend API>/.well-known/jwks.json`, `iss`
 * is the Frontend API URL, RS256, no `aud` (Clerk scopes with `azp` instead —
 * `authorizedParties`). The token is read from `Authorization: Bearer`
 * (cross-origin, per Clerk) and falls back to the `__session` cookie Clerk sets
 * on your domain for same-origin requests. Clock skew defaults to 5 seconds,
 * Clerk's own `DEFAULT_CLOCK_SKEW_IN_MS`.
 *
 * To verify with no network call, import Clerk's PEM "JWKS Public Key"
 * (Dashboard → API keys) with jose's `importSPKI(pem, "RS256")` and pass the
 * key as `keySet`.
 * @see https://clerk.com/docs/guides/sessions/manual-jwt-verification
 * @see https://clerk.com/docs/guides/development/making-requests
 *
 * Identity claims: `orgId`, `orgSlug`, `orgRole` (`org:admin`), `orgPermissions`
 * (`org:<feature>:<perm>` keys), `sessionId`. The org role is NOT copied into
 * `roles`: it is scoped to the active organization, and any user who creates an
 * organization is its `org:admin`. Map it to app roles deliberately with
 * `claims`, together with the `orgId` it belongs to.
 */
const clerk = (options: ClerkOptions): JwtIdentityResolver => {
    const authorizedParties = (typeof options.authorizedParties === "string" ? options.authorizedParties.split(",") : options.authorizedParties)
        .map((party) => party.trim())
        .filter((party) => party.length > 0);

    if (authorizedParties.length === 0) {
        throw new LunoraError(
            "INTERNAL",
            "@lunora/jwt-auth: `authorizedParties` is empty — list the origins allowed to mint tokens (check that CLERK_AUTHORIZED_PARTIES is set); Clerk warns that skipping this check opens the app to CSRF",
        );
    }

    const issuer = options.issuer === undefined ? clerkFrontendApi(options.publishableKey ?? "") : httpsOrigin(options.issuer, "issuer");

    return presetResolver(options, {
        algorithms: ["RS256"],
        claims: clerkClaims(authorizedParties),
        clockTolerance: 5,
        issuer,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        token: firstToken(bearerToken, cookieToken("__session")),
    });
};

// ---------------------------------------------------------------------------
// WorkOS AuthKit
// ---------------------------------------------------------------------------

interface WorkOsOptions extends PresetOverrides {
    /**
     * Your custom authentication domain (e.g. `auth.example.com`), the same host
     * the client's `apiHostname` points at. It then serves the JWKS and replaces
     * `https://api.workos.com` in `iss`. A value with a path is taken as the
     * exact expected `iss`.
     */
    authDomain?: string;

    /** The WorkOS client id (`client_…`) — names the JWKS and must match the token's `client_id`. */
    clientId: string;
}

/**
 * The `iss` values a WorkOS access token may carry. Production AuthKit tokens
 * carry `https://api.workos.com/user_management/<clientId>` (workos-node README,
 * "Access token issuer validation"; authkit-nextjs `session.spec.ts`); WorkOS's
 * session-token reference shows the bare `https://api.workos.com`, with and
 * without a trailing slash elsewhere in its docs. All three are accepted on the
 * configured host.
 */
const workosIssuers = (authDomain: string | undefined, clientId: string): { issuers: string[]; origin: string } => {
    if (authDomain === undefined) {
        const origin = "https://api.workos.com";

        return { issuers: [origin, `${origin}/`, `${origin}/user_management/${clientId}`], origin };
    }

    const origin = httpsOrigin(authDomain, "authDomain");
    const url = new URL(SCHEME.test(authDomain.trim()) ? authDomain.trim() : `https://${authDomain.trim()}`);

    return url.pathname === "/"
        ? { issuers: [origin, `${origin}/`, `${origin}/user_management/${clientId}`], origin }
        : { issuers: [`${origin}${url.pathname}`], origin };
};

/**
 * WorkOS AuthKit access tokens. JWKS at `<host>/sso/jwks/<clientId>` (the host
 * is `api.workos.com`, or your custom auth domain — the WorkOS SDKs build the
 * JWKS URL from the configured API hostname); see {@link workosIssuers} for
 * `iss`. There is no `aud`; the token's `client_id` is checked against
 * `clientId` when present (WorkOS's reference types it as always present, but
 * workos-node's own verification does not check it, so its absence is not
 * treated as an attack; the `user_management/<clientId>` issuer binds the
 * client either way).
 * @see https://workos.com/docs/reference/authkit/session-tokens
 *
 * Only USER access tokens resolve. The environment's key pair also signs agent
 * and widget tokens, so — as workos-node's `verifyAccessToken` does — a token
 * needs a string `sid` and a numeric `auth_time`, a `sub_profile` that is
 * absent or `"user"`, and no `sub_type`.
 * @see https://github.com/workos/workos-node/blob/main/src/user-management/user-management.ts (`hasRequiredAccessTokenClaims`)
 *
 * Identity claims: `orgId`, `role` and `orgRoles` (the active organization's
 * membership roles), `permissions`, `entitlements`, `featureFlags`,
 * `sessionId`, and `impersonator` when an admin is impersonating the user.
 * The roles are NOT copied into the global `roles` RLS reads: they are scoped
 * to `orgId`. Map them deliberately with `claims`.
 */
const workos = (options: WorkOsOptions): JwtIdentityResolver => {
    const clientId = options.clientId.trim();

    if (clientId.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: `clientId` is empty — check that WORKOS_CLIENT_ID is set");
    }

    const { issuers, origin } = workosIssuers(options.authDomain, clientId);

    const workosClaims: ClaimsMapper = (payload) => {
        if (
            typeof payload.sid !== "string" ||
            typeof payload.auth_time !== "number" ||
            (payload.sub_profile !== undefined && payload.sub_profile !== "user") ||
            payload.sub_type !== undefined ||
            (payload.client_id !== undefined && payload.client_id !== clientId)
        ) {
            return ANONYMOUS;
        }

        return defined({
            entitlements: stringList(payload.entitlements),
            featureFlags: stringList(payload.feature_flags),
            impersonator: isRecord(payload.act) ? nonEmpty(payload.act.sub) : undefined,
            orgId: nonEmpty(payload.org_id),
            orgRoles: stringList(payload.roles),
            permissions: stringList(payload.permissions),
            role: nonEmpty(payload.role),
            sessionId: payload.sid,
        });
    };

    return presetResolver(options, {
        algorithms: ["RS256"],
        claims: workosClaims,
        issuer: issuers,
        jwksUrl: `${origin}/sso/jwks/${encodeURIComponent(clientId)}`,
    });
};

// ---------------------------------------------------------------------------
// Auth0
// ---------------------------------------------------------------------------

interface Auth0Options extends PresetOverrides {
    /**
     * Accept machine-to-machine and agent access tokens as identities. Off by
     * default: their subject is an application or agent rather than a user, and
     * treating it as `ctx.auth.userId` would let any such client for your API
     * act as a signed-in user.
     */
    allowClientCredentials?: boolean;

    /** Your API's identifier — the access token's `aud`. Required: it is what scopes a token to your API. */
    audience: string;

    /** Your Auth0 domain, e.g. `acme.us.auth0.com` or a custom domain. */
    domain: string;
}

/**
 * Whether an Auth0 access token was issued to an application rather than a
 * user. The Auth0 profile marks client-credentials grants with `gty`; the
 * RFC 9068 profile has no `gty` but keeps the `<client_id>@clients` subject;
 * an agent-linked client or an API with agent subject claims drops that suffix
 * and classifies the subject with `sub_profile` instead.
 * @see https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles
 */
const isAuth0MachineToken = (payload: JWTPayload): boolean =>
    payload.gty === "client-credentials" ||
    (typeof payload.sub === "string" && payload.sub.endsWith("@clients")) ||
    (payload.sub_profile !== undefined && payload.sub_profile !== "user");

/**
 * Auth0 access tokens. JWKS at `https://<domain>/.well-known/jwks.json`, `iss`
 * is `https://<domain>/` (trailing slash), `aud` is your API identifier, RS256.
 * Forwards `permissions` (RBAC "Add Permissions in the Access Token"), `scopes`
 * (the space-separated `scope` claim, split) and `orgId` (`org_id`,
 * Organizations — validate it against the organization you expect before
 * trusting it, as Auth0 advises). Machine-to-machine and agent tokens resolve
 * anonymous unless `allowClientCredentials` is set.
 * @see https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles
 * @see https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens
 * @see https://auth0.com/docs/get-started/apis/enable-role-based-access-control-for-apis
 * @see https://auth0.com/docs/manage-users/organizations/using-tokens
 */
const auth0 = (options: Auth0Options): JwtIdentityResolver => {
    const origin = httpsOrigin(options.domain, "domain");

    if (options.audience.trim().length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/jwt-auth: `audience` is empty — set it to your Auth0 API identifier");
    }

    return presetResolver(options, {
        algorithms: ["RS256"],
        audience: options.audience,
        claims: (payload) =>
            isAuth0MachineToken(payload) && options.allowClientCredentials !== true
                ? ANONYMOUS
                : defined({
                      orgId: nonEmpty(payload.org_id),
                      permissions: stringList(payload.permissions),
                      scopes: typeof payload.scope === "string" ? stringList(payload.scope.split(WHITESPACE)) : undefined,
                  }),
        issuer: `${origin}/`,
        jwksUrl: `${origin}/.well-known/jwks.json`,
    });
};

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------

interface SupabaseOptions extends PresetOverrides {
    /**
     * Accept Supabase anonymous sign-ins as identities. Off by default: an
     * anonymous user's token verifies like a permanent user's (it assumes the
     * `authenticated` role), so without this check `ctx.auth.userId` would be set
     * and RLS would treat a guest as signed in. When enabled, the identity
     * carries `isAnonymous: true` so policies can tell them apart.
     */
    allowAnonymousUsers?: boolean;

    /** Your project URL, e.g. `https://<project-ref>.supabase.co`. */
    projectUrl: string;
}

/**
 * Supabase Auth user tokens signed with asymmetric keys (ES256 / RS256; the
 * legacy HS256 secret has no public key and cannot be verified this way). JWKS
 * at `<project>/auth/v1/.well-known/jwks.json`, `iss` is `<project>/auth/v1`,
 * `aud` is `authenticated`. Anonymous sign-ins (`is_anonymous: true`) also
 * carry the `authenticated` role, so they resolve anonymous unless
 * `allowAnonymousUsers` is set. Forwards `email`, `role` (the Postgres role),
 * `aal`, `isAnonymous` and `sessionId`.
 * @see https://supabase.com/docs/guides/auth/auth-anonymous
 * @see https://supabase.com/docs/guides/auth/signing-keys
 * @see https://supabase.com/docs/guides/auth/jwt-fields
 */
const supabase = (options: SupabaseOptions): JwtIdentityResolver => {
    const origin = httpsOrigin(options.projectUrl, "projectUrl");

    return presetResolver(options, {
        algorithms: ["ES256", "RS256"],
        audience: "authenticated",
        claims: (payload) =>
            payload.is_anonymous === true && options.allowAnonymousUsers !== true
                ? ANONYMOUS
                : defined({
                      aal: nonEmpty(payload.aal),
                      email: nonEmpty(payload.email),
                      isAnonymous: typeof payload.is_anonymous === "boolean" ? payload.is_anonymous : undefined,
                      role: nonEmpty(payload.role),
                      sessionId: nonEmpty(payload.session_id),
                  }),
        issuer: `${origin}/auth/v1`,
        jwksUrl: `${origin}/auth/v1/.well-known/jwks.json`,
    });
};

export type { Auth0Options, ClerkOptions, SupabaseOptions, WorkOsOptions };
export { auth0, clerk, supabase, workos };
