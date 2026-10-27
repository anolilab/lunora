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
import { workos } from "@lunora/jwt-auth";
import type { IdentityResolver } from "@lunora/runtime";
import { memoizeIdentity } from "@lunora/runtime";

/**
 * One memoized resolver per `env` object. A framework-hosted worker
 * (`buildFrameworkWorker`) rebuilds its options on every request, so a resolver
 * built per call would start each request with an empty cache and re-verify
 * every token; `memoizeIdentity` reuses a verification for 5 s.
 */
const resolvers = new WeakMap<object, IdentityResolver>();

/**
 * A string env var, or `""` when unset. Read by name, so the resolver accepts
 * whatever `Env` type the Worker entry declares.
 */
const envString = (env: object, name: string): string => {
    const value: unknown = Reflect.get(env, name);

    return typeof value === "string" ? value : "";
};

/**
 * Build the WorkOS identity resolver from WORKOS_CLIENT_ID and, when you use a
 * custom authentication domain, WORKOS_AUTH_DOMAIN (the host the client's
 * `apiHostname` names). Throws at startup when WORKOS_CLIENT_ID is unset, so a
 * misconfigured deployment never boots resolving every caller to anonymous.
 */
export const workosIdentity = (env: object): IdentityResolver => {
    let resolver = resolvers.get(env);

    if (resolver === undefined) {
        const authDomain = envString(env, "WORKOS_AUTH_DOMAIN");

        resolver = memoizeIdentity(workos({ ...(authDomain ? { authDomain } : {}), clientId: envString(env, "WORKOS_CLIENT_ID") }));
        resolvers.set(env, resolver);
    }

    return resolver;
};
