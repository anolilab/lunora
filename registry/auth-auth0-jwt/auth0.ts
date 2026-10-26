/**
 * Auth0 access tokens → ctx.auth — added by `lunora registry add auth-auth0-jwt`.
 *
 * Auth0 owns the session; Lunora only verifies it. Each request's Auth0 access
 * token for your API (`Authorization: Bearer`) is checked against your tenant's
 * JWKS, issuer and API audience, and the verified user becomes
 * `ctx.auth.userId`. The identity also carries `permissions` (RBAC), `scopes`
 * and `orgId` (Organizations). Machine-to-machine and agent tokens resolve
 * anonymous.
 *
 * Wire it into your Worker entry as the `resolveIdentity` option:
 *
 *   import { auth0Identity } from "../../lunora/identity/auth0"; // from src/server/index.ts
 *
 *   createWorker({ resolveIdentity: auth0Identity(env), shardDO: env.SHARD });
 *
 * On the client, let LunoraClient keep the access token fresh:
 *
 *   const client = new LunoraClient({ url, authTokenOnUpgrade: true });
 *   const stop = setAuthTokenProvider(client, fetchToken, { subject: user.sub });
 */
import type { JwtIdentityResolver } from "@lunora/jwt-auth";
import { auth0 } from "@lunora/jwt-auth";

interface Auth0Env {
    /** Your API's identifier (Dashboard → Applications → APIs), the access token's `aud`. */
    AUTH0_AUDIENCE?: string;
    /** Your Auth0 domain, e.g. `acme.us.auth0.com`, or your custom domain. */
    AUTH0_DOMAIN?: string;
}

/**
 * Build the Auth0 identity resolver. Throws at startup when AUTH0_DOMAIN or
 * AUTH0_AUDIENCE is unset, so a misconfigured deployment never boots resolving
 * every caller to anonymous.
 */
export const auth0Identity = (env: Auth0Env): JwtIdentityResolver =>
    auth0({
        audience: env.AUTH0_AUDIENCE ?? "",
        domain: env.AUTH0_DOMAIN ?? "",
    });
