/**
 * Sign in with Clerk — added by `cirrus registry add auth-clerk`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * Clerk is wired as a generic OIDC provider through better-auth's
 * `genericOAuth` plugin. `@cirrus/auth` also re-exports it as
 * `import { genericOAuth } from "@cirrus/auth/plugins"` — switch to that if you
 * prefer the Cirrus-namespaced import path; it's the same factory. We import the
 * documented better-auth path here so the snippet has no extra coupling. The
 * plugin discovers Clerk's authorization, token,
 * and userinfo endpoints from its OIDC discovery document at
 * `<CLERK_ISSUER_URL>/.well-known/openid-configuration`.
 *
 * See https://www.better-auth.com/docs/plugins/generic-oauth for the full
 * config surface.
 *
 * # Wire it into your auth instance
 *
 * Merge this plugin into the `plugins` array in `cirrus/auth/index.ts`:
 *
 * ```ts
 * // cirrus/auth/index.ts
 * import { clerk } from "./clerk.js";
 *
 * export const buildAuth = (env: AuthEnv): CirrusAuth =>
 *     createAuth({
 *         baseURL: env.BETTER_AUTH_URL,
 *         database: env.DB as never,
 *         emailAndPassword: { enabled: true },
 *         secret: env.BETTER_AUTH_SECRET,
 *         plugins: [clerk(env)],
 *     });
 * ```
 *
 * Widen `AuthEnv` (in `cirrus/auth/index.ts`) with the Clerk vars, or import
 * {@link ClerkEnv} from here.
 *
 * # Clerk dashboard setup
 *
 * Create an OAuth application in the Clerk dashboard and set its redirect /
 * callback URL to:
 *
 *     <BETTER_AUTH_URL>/api/auth/oauth2/callback/clerk
 *
 * Then fill `CLERK_CLIENT_ID`, `CLERK_CLIENT_SECRET`, and `CLERK_ISSUER_URL`
 * in `.dev.vars` (and as Wrangler secrets in production).
 */
import { genericOAuth } from "better-auth/plugins/generic-oauth";

/** The Worker env bindings this provider reads. */
export interface ClerkEnv {
    /** OAuth client ID from your Clerk application. */
    CLERK_CLIENT_ID: string;
    /** OAuth client secret from your Clerk application. */
    CLERK_CLIENT_SECRET: string;
    /** Clerk OIDC issuer, e.g. https://your-app.clerk.accounts.dev. */
    CLERK_ISSUER_URL: string;
}

/**
 * Build the Clerk OIDC provider plugin. `providerId: "clerk"` is what shows up
 * in the callback path (`/api/auth/oauth2/callback/clerk`) and in the
 * client-side `signIn.oauth2({ providerId: "clerk" })` call.
 */
export const clerk = (env: ClerkEnv): ReturnType<typeof genericOAuth> =>
    genericOAuth({
        config: [
            {
                clientId: env.CLERK_CLIENT_ID,
                clientSecret: env.CLERK_CLIENT_SECRET,
                // OIDC discovery: better-auth fetches the authorization, token,
                // and userinfo endpoints from this document.
                discoveryUrl: `${env.CLERK_ISSUER_URL.replace(/\/$/, "")}/.well-known/openid-configuration`,
                pkce: true,
                providerId: "clerk",
                scopes: ["openid", "email", "profile"],
            },
        ],
    });
