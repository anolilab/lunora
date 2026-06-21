/**
 * Sign in with Auth0 — added by `lunora registry add auth-auth0`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * Auth0 is wired as a generic OIDC provider through better-auth's
 * `genericOAuth` plugin. `@lunora/auth` also re-exports it as
 * `import { genericOAuth } from "@lunora/auth/plugins"` — switch to that if you
 * prefer the Lunora-namespaced import path; it's the same factory. We import the
 * documented better-auth path here so the snippet has no extra coupling. The
 * plugin discovers Auth0's authorization, token,
 * and userinfo endpoints from its OIDC discovery document at
 * `https://<AUTH0_DOMAIN>/.well-known/openid-configuration`.
 *
 * See https://www.better-auth.com/docs/plugins/generic-oauth for the full
 * config surface.
 *
 * # Wire it into your auth instance
 *
 * Merge this plugin into the `plugins` array in `lunora/auth/index.ts`:
 *
 * ```ts
 * // lunora/auth/index.ts
 * import { auth0 } from "./auth0.js";
 *
 * export const buildAuth = (env: AuthEnv): LunoraAuth =>
 *     createAuth({
 *         baseURL: env.BETTER_AUTH_URL,
 *         database: env.DB as never,
 *         emailAndPassword: { enabled: true },
 *         secret: env.BETTER_AUTH_SECRET,
 *         plugins: [auth0(env)],
 *     });
 * ```
 *
 * Widen `AuthEnv` (in `lunora/auth/index.ts`) with the Auth0 vars, or import
 * {@link Auth0Env} from here.
 *
 * # Auth0 studio setup
 *
 * Create a **Regular Web Application** in the Auth0 studio and set its
 * Allowed Callback URL to:
 *
 *     <BETTER_AUTH_URL>/api/auth/oauth2/callback/auth0
 *
 * Then fill `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and `AUTH0_DOMAIN`
 * in `.dev.vars` (and as Wrangler secrets in production).
 */
import { genericOAuth } from "better-auth/plugins/generic-oauth";

/** The Worker env bindings this provider reads. */
export interface Auth0Env {
    /** Client ID from your Auth0 Regular Web Application. */
    AUTH0_CLIENT_ID: string;
    /** Client Secret from your Auth0 Regular Web Application. */
    AUTH0_CLIENT_SECRET: string;
    /** Auth0 tenant domain, e.g. your-tenant.us.auth0.com (no scheme). */
    AUTH0_DOMAIN: string;
}

/**
 * Build the Auth0 OIDC provider plugin. `providerId: "auth0"` is what shows up
 * in the callback path (`/api/auth/oauth2/callback/auth0`) and in the
 * client-side `signIn.oauth2({ providerId: "auth0" })` call.
 */
export const auth0 = (env: Auth0Env): ReturnType<typeof genericOAuth> =>
    genericOAuth({
        config: [
            {
                clientId: env.AUTH0_CLIENT_ID,
                clientSecret: env.AUTH0_CLIENT_SECRET,
                // OIDC discovery: better-auth fetches the authorization, token,
                // and userinfo endpoints from this document. AUTH0_DOMAIN is a
                // bare host (no scheme); we prefix https:// here.
                discoveryUrl: `https://${env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}/.well-known/openid-configuration`,
                pkce: true,
                providerId: "auth0",
                scopes: ["openid", "email", "profile"],
            },
        ],
    });
