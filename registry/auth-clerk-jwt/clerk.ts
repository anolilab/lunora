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
import { clerk } from "@lunora/jwt-auth";
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
 * Build the Clerk identity resolver from CLERK_PUBLISHABLE_KEY (it encodes the
 * Frontend API that issues the tokens) and CLERK_AUTHORIZED_PARTIES (the
 * comma-separated origins allowed in `azp`). Throws at startup when either is
 * unset or empty, so a misconfigured deployment never boots resolving every
 * caller to anonymous or skipping the `azp` check.
 */
export const clerkIdentity = (env: object): IdentityResolver => {
    let resolver = resolvers.get(env);

    if (resolver === undefined) {
        resolver = memoizeIdentity(
            clerk({
                authorizedParties: envString(env, "CLERK_AUTHORIZED_PARTIES"),
                publishableKey: envString(env, "CLERK_PUBLISHABLE_KEY"),
            }),
        );
        resolvers.set(env, resolver);
    }

    return resolver;
};
