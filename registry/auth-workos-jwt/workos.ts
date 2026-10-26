/**
 * WorkOS AuthKit access tokens → ctx.auth — added by `lunora registry add auth-workos-jwt`.
 *
 * WorkOS owns the session; Lunora only verifies it. The AuthKit access token
 * (sent as `Authorization: Bearer`) is checked against your client's JWKS, and
 * the verified user becomes `ctx.auth.userId`. The organization lands on the
 * identity as `orgId`, with that membership's `role` / `orgRoles` /
 * `permissions`, plus `entitlements` and `featureFlags`. The roles are scoped to
 * the organization, so they are not copied into the app-wide `roles` RLS reads:
 * check them together with `orgId` in your policies.
 *
 * Wire it into your Worker entry as the `resolveIdentity` option:
 *
 *   import { workosIdentity } from "../../lunora/identity/workos"; // from src/server/index.ts
 *
 *   createWorker({ resolveIdentity: workosIdentity(env), shardDO: env.SHARD });
 *
 * On the client, let LunoraClient keep the access token fresh (a
 * `LoginRequiredError` from `getAccessToken()` means signed out, so map it to `null`):
 *
 *   const client = new LunoraClient({ url, authTokenOnUpgrade: true });
 *   const stop = setAuthTokenProvider(client, fetchToken, { subject: user.id });
 */
import type { JwtIdentityResolver } from "@lunora/jwt-auth";
import { workos } from "@lunora/jwt-auth";

interface WorkOsEnv {
    /** Your custom authentication domain, when configured. Must be the host the client's `apiHostname` names. */
    WORKOS_AUTH_DOMAIN?: string;
    /** Your WorkOS client id (`client_…`). */
    WORKOS_CLIENT_ID?: string;
}

/**
 * Build the WorkOS identity resolver. Throws at startup when WORKOS_CLIENT_ID
 * is unset, so a misconfigured deployment never boots resolving every caller to
 * anonymous.
 */
export const workosIdentity = (env: WorkOsEnv): JwtIdentityResolver =>
    workos({
        ...(env.WORKOS_AUTH_DOMAIN ? { authDomain: env.WORKOS_AUTH_DOMAIN } : {}),
        clientId: env.WORKOS_CLIENT_ID ?? "",
    });
