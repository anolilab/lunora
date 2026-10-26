/**
 * Clerk session tokens → ctx.auth — added by `lunora registry add auth-clerk-jwt`.
 *
 * Clerk owns the session; Lunora only verifies it. Each request's Clerk session
 * token (the `__session` cookie on same-origin requests, `Authorization: Bearer`
 * otherwise) is checked against your instance's JWKS, and the verified user
 * becomes `ctx.auth.userId`. The active organization lands on the identity as
 * `orgId` / `orgRole` (`org:admin`) / `orgPermissions`. The org role is scoped
 * to that organization, so it is not copied into the app-wide `roles` RLS reads:
 * check it together with `orgId` in your policies.
 *
 * Wire it into your Worker entry as the `resolveIdentity` option:
 *
 *   import { clerkIdentity } from "../../lunora/identity/clerk"; // from src/server/index.ts
 *
 *   createWorker({ resolveIdentity: clerkIdentity(env), shardDO: env.SHARD });
 *
 * On the client, let LunoraClient keep Clerk's token fresh:
 *
 *   const client = new LunoraClient({ url, authTokenOnUpgrade: true });
 *   const stop = setAuthTokenProvider(client, () => getToken(), { subject: userId });
 */
import type { JwtIdentityResolver } from "@lunora/jwt-auth";
import { clerk } from "@lunora/jwt-auth";

interface ClerkEnv {
    /** Comma-separated origins allowed in the token's `azp` claim (your app's URLs). Required. */
    CLERK_AUTHORIZED_PARTIES?: string;
    /** Your Clerk publishable key (`pk_test_…` / `pk_live_…`); it encodes the Frontend API the tokens are issued by. */
    CLERK_PUBLISHABLE_KEY?: string;
}

/**
 * Build the Clerk identity resolver. Throws at startup when
 * CLERK_PUBLISHABLE_KEY or CLERK_AUTHORIZED_PARTIES is unset or empty, so a
 * misconfigured deployment never boots resolving every caller to anonymous or
 * skipping the `azp` check.
 */
export const clerkIdentity = (env: ClerkEnv): JwtIdentityResolver =>
    clerk({
        authorizedParties: env.CLERK_AUTHORIZED_PARTIES ?? "",
        publishableKey: env.CLERK_PUBLISHABLE_KEY ?? "",
    });
