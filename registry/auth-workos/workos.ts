/**
 * WorkOS AuthKit access tokens → ctx.auth — added by `lunora registry add auth-workos`.
 *
 * WorkOS owns the session; Lunora only verifies it. The AuthKit access token
 * (sent as `Authorization: Bearer`; authkit-react keeps it in memory, not in a
 * cookie on your domain) is checked against your client's JWKS, and the
 * verified user becomes `ctx.auth.userId`. The organization lands on the
 * identity as `orgId`, the role as `role` + `roles` (read by RLS), plus
 * `permissions`, `entitlements` and `featureFlags`.
 *
 * Wire it into your Worker entry as the `resolveIdentity` option:
 *
 *   import { workosIdentity } from "../lunora/identity/workos";
 *
 *   createWorker({ resolveIdentity: workosIdentity(env), shardDO: env.SHARD });
 *
 * On the client, give LunoraClient the token and let sockets carry it:
 *
 *   const client = new LunoraClient({ url, authTokenOnUpgrade: true });
 *   client.setAuthToken(await getAccessToken());
 *   client.onTokenExpired(async () => client.setAuthToken(await getAccessToken()));
 */
import type { JwtIdentityResolver } from "@lunora/jwt-auth";
import { workos } from "@lunora/jwt-auth";

interface WorkOsEnv {
    /** Your custom auth domain, when configured (it then issues the tokens instead of api.workos.com). */
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
