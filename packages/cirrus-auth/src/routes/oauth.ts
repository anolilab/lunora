import { buildSessionCookie, createSession, createUser, ensureSchema, findUserByProvider, generateId, readSessionCookie } from "../session.js";
import type { AuthProviderContext, RouteHandler } from "../types.js";
import { jsonError } from "./_shared.js";

/** Constant-time string comparison for CSRF token validation. */
const constantTimeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let mismatch = 0;

    for (let index = 0; index < a.length; index += 1) {
        mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
    }

    return mismatch === 0;
};

export interface OAuthProviderDescriptor {
    /** Provider id, e.g. `github`. */
    id: string;
    /** OAuth authorization endpoint. */
    authorizationUrl: string;
    /** Default OAuth scope string for the provider. */
    defaultScope: string;
    clientId: string;
    clientSecret: string;
}

const textEncoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** RFC 7636 §4.2 PKCE S256 challenge derivation. */
export const deriveCodeChallenge = async (verifier: string): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier));

    return toBase64Url(new Uint8Array(hash));
};

/** Builds the authorization redirect URL for the `GET /auth/oauth/:provider/start` route. */
export const buildAuthorizeRedirect = (descriptor: OAuthProviderDescriptor, redirectUri: string, state: string, codeChallenge: string): string => {
    const url = new URL(descriptor.authorizationUrl);

    url.searchParams.set("client_id", descriptor.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", descriptor.defaultScope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return url.toString();
};

/**
 * Normalized profile returned by every provider exchange. Providers report
 * different keys upstream (`login` vs `name`, `id` vs `sub`) — we collapse
 * them to a single shape here so the callback handler stays provider-agnostic.
 */
export interface OAuthProfile {
    providerAccountId: string;
    email: string | null;
    name: string | null;
}

interface GithubUserResponse {
    id: number;
    login?: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
}

interface GithubEmailEntry {
    email: string;
    primary: boolean;
    verified: boolean;
    visibility?: string | null;
}

interface GithubTokenResponse {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

interface GoogleTokenResponse {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

interface GoogleIdTokenClaims {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
}

/**
 * Decode a JWT payload without signature verification.
 *
 * TODO(v0.2): verify id_token signature against Google's JWKS
 * (https://www.googleapis.com/oauth2/v3/certs). For v0.1 we trust the TLS
 * connection to oauth2.googleapis.com — the token never traverses an
 * untrusted hop because we fetched it ourselves over HTTPS.
 */
export const decodeIdTokenPayload = (idToken: string): Record<string, unknown> => {
    const parts = idToken.split(".");

    if (parts.length !== 3) {
        throw new Error("malformed id_token: expected three dot-separated segments");
    }

    const payload = parts[1]!;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

    let decoded: string;

    try {
        decoded = atob(padded);
    } catch {
        throw new Error("malformed id_token: payload is not valid base64url");
    }

    let bytesAsString = "";

    for (let index = 0; index < decoded.length; index += 1) {
        bytesAsString += decoded.charCodeAt(index).toString(16).padStart(2, "0");
    }

    const utf8 = decodeURIComponent(
        bytesAsString
            .match(/.{2}/g)!
            .map((hex) => "%" + hex)
            .join(""),
    );

    return JSON.parse(utf8) as Record<string, unknown>;
};

/**
 * Real GitHub code -> token -> user exchange.
 *
 * Two-step:
 *   1) POST github.com/login/oauth/access_token (form-encoded body, JSON accept)
 *   2) GET api.github.com/user (Authorization: Bearer <token>)
 *      — if the resulting `email` is null (private email), fetch /user/emails
 *        and pick the primary verified entry.
 */
export const exchangeGithubCode = async (
    descriptor: OAuthProviderDescriptor,
    code: string,
    redirectUri: string,
    codeVerifier: string,
): Promise<OAuthProfile> => {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            client_id: descriptor.clientId,
            client_secret: descriptor.clientSecret,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        }).toString(),
    });

    if (!tokenResponse.ok) {
        throw new Error(`github token exchange failed: HTTP ${tokenResponse.status}`);
    }

    const tokenBody = (await tokenResponse.json()) as GithubTokenResponse;

    if (tokenBody.error || !tokenBody.access_token) {
        throw new Error(`github token exchange returned error: ${tokenBody.error ?? "missing access_token"}`);
    }

    const userResponse = await fetch("https://api.github.com/user", {
        headers: {
            authorization: `Bearer ${tokenBody.access_token}`,
            accept: "application/vnd.github+json",
            "user-agent": "cirrus-auth",
        },
    });

    if (!userResponse.ok) {
        throw new Error(`github /user failed: HTTP ${userResponse.status}`);
    }

    const user = (await userResponse.json()) as GithubUserResponse;
    let email: string | null = user.email ?? null;

    if (!email) {
        // GitHub returns null on the public profile when the user keeps their
        // primary email private. The `user:email` scope grants us /user/emails;
        // pick the primary verified row, otherwise the first verified row, and
        // fall back to null if nothing matches.
        const emailsResponse = await fetch("https://api.github.com/user/emails", {
            headers: {
                authorization: `Bearer ${tokenBody.access_token}`,
                accept: "application/vnd.github+json",
                "user-agent": "cirrus-auth",
            },
        });

        if (emailsResponse.ok) {
            const emails = (await emailsResponse.json()) as GithubEmailEntry[];
            const primary = emails.find((entry) => entry.primary && entry.verified);
            const anyVerified = emails.find((entry) => entry.verified);

            email = primary?.email ?? anyVerified?.email ?? null;
        }
    }

    return {
        providerAccountId: String(user.id),
        email,
        name: user.name ?? user.login ?? null,
    };
};

/**
 * Real Google code -> token -> id_token decode exchange.
 *
 * Google returns an `id_token` (signed JWT) in addition to the bearer
 * access_token. We decode the JWT payload to read the user's identity —
 * signature verification is deferred (see {@link decodeIdTokenPayload}).
 */
export const exchangeGoogleCode = async (
    descriptor: OAuthProviderDescriptor,
    code: string,
    redirectUri: string,
    codeVerifier: string,
): Promise<OAuthProfile> => {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: descriptor.clientId,
            client_secret: descriptor.clientSecret,
            code,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: codeVerifier,
        }).toString(),
    });

    if (!tokenResponse.ok) {
        throw new Error(`google token exchange failed: HTTP ${tokenResponse.status}`);
    }

    const tokenBody = (await tokenResponse.json()) as GoogleTokenResponse;

    if (tokenBody.error || !tokenBody.id_token) {
        throw new Error(`google token exchange returned error: ${tokenBody.error ?? "missing id_token"}`);
    }

    const claims = decodeIdTokenPayload(tokenBody.id_token) as unknown as GoogleIdTokenClaims;

    if (!claims.sub) {
        throw new Error("google id_token missing `sub` claim");
    }

    return {
        providerAccountId: claims.sub,
        email: claims.email ?? null,
        name: claims.name ?? null,
    };
};

/**
 * Dispatch the provider-specific exchange. Keeps the callback handler
 * provider-agnostic — adding a new OAuth provider only requires wiring its
 * id here plus a new descriptor.
 */
export const exchangeCodeForUser = async (
    descriptor: OAuthProviderDescriptor,
    code: string,
    redirectUri: string,
    codeVerifier: string,
): Promise<OAuthProfile> => {
    if (descriptor.id === "github") {
        return exchangeGithubCode(descriptor, code, redirectUri, codeVerifier);
    }

    if (descriptor.id === "google") {
        return exchangeGoogleCode(descriptor, code, redirectUri, codeVerifier);
    }

    throw new Error(`unsupported OAuth provider id: ${descriptor.id}`);
};

/**
 * Deterministic placeholder hash for social-signup users. The schema
 * constrains `password_hash` to be set only for `email-password` accounts —
 * social signups satisfy the column with a sentinel that can never verify
 * (PBKDF2 hashes start with `pbkdf2$`; the literal `oauth$social` will fail
 * `verifyPassword` immediately).
 */
const SOCIAL_PASSWORD_PLACEHOLDER = "oauth$social";

/** Mounts `GET /auth/oauth/:provider/start` and `GET /auth/oauth/:provider/callback`. */
export const oauthRoutes = (descriptor: OAuthProviderDescriptor, context: AuthProviderContext): Record<string, RouteHandler> => {
    const startPath = `GET /auth/oauth/${descriptor.id}/start`;
    const callbackPath = `GET /auth/oauth/${descriptor.id}/callback`;

    const verifierCookieName = `cirrus_oauth_v_${descriptor.id}`;
    const stateCookieName = `cirrus_oauth_s_${descriptor.id}`;

    const start: RouteHandler = async (request) => {
        const url = new URL(request.url);
        const redirectUri = url.searchParams.get("redirect_uri") ?? `${url.origin}/auth/oauth/${descriptor.id}/callback`;
        const verifier = generateId() + generateId();
        const state = generateId();
        const challenge = await deriveCodeChallenge(verifier);
        const target = buildAuthorizeRedirect(descriptor, redirectUri, state, challenge);

        // Headers.append is required so the multiple Set-Cookie values reach
        // the browser as separate headers — never join cookies into one value.
        const headers = new Headers({ location: target });

        headers.append("set-cookie", `${verifierCookieName}=${verifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
        headers.append("set-cookie", `${stateCookieName}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);

        return new Response(null, { status: 302, headers });
    };

    const callback: RouteHandler = async (request, env) => {
        // Pull live secrets off the env at request time — the descriptor on
        // the provider config is the build-time placeholder. If either is
        // unset we 503 (per the task spec) instead of falling back to a
        // stub user.
        const liveClientId = readEnvString(env, `OAUTH_${descriptor.id.toUpperCase()}_CLIENT_ID`) ?? descriptor.clientId;
        const liveClientSecret = readEnvString(env, `OAUTH_${descriptor.id.toUpperCase()}_CLIENT_SECRET`) ?? descriptor.clientSecret;

        if (!liveClientId || !liveClientSecret) {
            return jsonError(503, "OAUTH_NOT_CONFIGURED", `OAuth credentials for "${descriptor.id}" are not configured`);
        }

        await ensureSchema(context.db);

        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
            return jsonError(400, "INVALID_CALLBACK", "missing code or state");
        }

        // CSRF guard: the `state` query param must match the `state` cookie
        // we set in `/start`. Read both before doing anything else.
        const cookieState = readSessionCookie(request, stateCookieName);
        const cookieVerifier = readSessionCookie(request, verifierCookieName);

        if (!cookieState || !constantTimeEqual(cookieState, state)) {
            return jsonError(400, "STATE_MISMATCH", "oauth state did not match");
        }

        if (!cookieVerifier) {
            return jsonError(400, "MISSING_VERIFIER", "oauth code_verifier cookie missing");
        }

        const redirectUri = url.searchParams.get("redirect_uri") ?? `${url.origin}/auth/oauth/${descriptor.id}/callback`;

        let profile: OAuthProfile;

        try {
            profile = await exchangeCodeForUser(
                { ...descriptor, clientId: liveClientId, clientSecret: liveClientSecret },
                code,
                redirectUri,
                cookieVerifier,
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "unknown exchange error";

            return jsonError(502, "OAUTH_EXCHANGE_FAILED", message);
        }

        let user = await findUserByProvider(context.db, descriptor.id, profile.providerAccountId);

        if (!user) {
            user = await createUser(context.db, {
                email: profile.email,
                name: profile.name,
                passwordHash: SOCIAL_PASSWORD_PLACEHOLDER,
                provider: descriptor.id,
                providerAccountId: profile.providerAccountId,
            });
        }

        const { token, session } = await createSession(env, user.id, context.sessionTtlSeconds);

        const responseHeaders = new Headers({ "content-type": "application/json" });

        responseHeaders.append("set-cookie", buildSessionCookie(context.cookieName, token, context.sessionTtlSeconds));
        // Clear the short-lived OAuth cookies — they must not survive a successful exchange.
        responseHeaders.append("set-cookie", `${verifierCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        responseHeaders.append("set-cookie", `${stateCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

        return new Response(JSON.stringify({ user, session: { id: session.id, expiresAt: session.expiresAt } }), {
            status: 200,
            headers: responseHeaders,
        });
    };

    return { [startPath]: start, [callbackPath]: callback };
};

const readEnvString = (env: unknown, key: string): string | null => {
    if (!env || typeof env !== "object") {
        return null;
    }

    const value = (env as Record<string, unknown>)[key];

    return typeof value === "string" && value.length > 0 ? value : null;
};
