/**
 * Clerk session tokens → ctx.auth — added by `lunora registry add auth-clerk-jwt`.
 *
 * Clerk owns the session; Lunora only verifies it. Each request's Clerk session
 * token (the `__session` cookie on same-origin requests, `Authorization: Bearer`
 * otherwise) is checked against your instance's JWKS, and the verified user
 * becomes `ctx.auth.userId`. The active organization lands on the identity as
 * `orgId` / `orgRole` / `orgPermissions`, and `roles: [orgRole]` feeds RLS.
 *
 * Wire it into your Worker entry as the `resolveIdentity` option:
 *
 *   import { clerkIdentity } from "../lunora/identity/clerk";
 *
 *   createWorker({ resolveIdentity: clerkIdentity(env), shardDO: env.SHARD });
 *
 * On the client, give LunoraClient the token and let sockets carry it:
 *
 *   const client = new LunoraClient({ url, authTokenOnUpgrade: true });
 *   client.setAuthToken(await getToken());
 *   client.onTokenExpired(async () => client.setAuthToken(await getToken()));
 */
import type { JwtIdentityResolver } from "@lunora/jwt-auth";
import { clerk } from "@lunora/jwt-auth";

interface ClerkEnv {
    /** Comma-separated origins allowed in the token's `azp` claim (your app's URLs). */
    CLERK_AUTHORIZED_PARTIES?: string;
    /** Your Clerk publishable key (`pk_test_…` / `pk_live_…`); it encodes the Frontend API the tokens are issued by. */
    CLERK_PUBLISHABLE_KEY?: string;
}

/**
 * Build the Clerk identity resolver. Throws at startup when
 * CLERK_PUBLISHABLE_KEY is unset, so a misconfigured deployment never boots
 * resolving every caller to anonymous.
 */
export const clerkIdentity = (env: ClerkEnv): JwtIdentityResolver =>
    clerk({
        authorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
        publishableKey: env.CLERK_PUBLISHABLE_KEY ?? "",
    });
