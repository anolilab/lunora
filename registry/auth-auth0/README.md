# auth-auth0

Sign in with [Auth0](https://auth0.com) for Cirrus auth. Wires Auth0 as an OIDC provider through [better-auth](https://www.better-auth.com)'s [`genericOAuth`](https://www.better-auth.com/docs/plugins/generic-oauth) plugin (also re-exported by [`@cirrus/auth/plugins`](../../packages/auth)), on top of the base [`auth`](../auth) item.

This closes the Convex-parity gap for Auth0-style hosted auth (CONVEX-PARITY #15) as a registry item you own and edit.

## Install

```bash
cirrus registry add auth-auth0
```

Because this item declares `requires: ["auth"]`, the registry resolves and installs the base **auth** item first (deps before dependents), then this one. The base item brings `@cirrus/auth` + `@cirrus/server` and scaffolds `cirrus/auth/index.ts`; this item adds:

1. `@cirrus/auth` (already present from the base item) and `better-auth` to `package.json` — run `pnpm install` once.
2. `cirrus/auth/auth0.ts` — the Auth0 OIDC provider plugin (`auth0(env)`). It's **yours** to edit.
3. `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_DOMAIN` into your `.dev.vars`.

## Env vars

| Var                   | Secret | Notes                                                                             |
| --------------------- | ------ | --------------------------------------------------------------------------------- |
| `AUTH0_CLIENT_ID`     | yes    | Client ID from your Auth0 Regular Web Application.                                |
| `AUTH0_CLIENT_SECRET` | yes    | Client Secret from your Auth0 Regular Web Application.                            |
| `AUTH0_DOMAIN`        | no     | Tenant domain, e.g. `your-tenant.us.auth0.com` (no scheme). Endpoints discovered. |

Set the secrets in production with Wrangler:

```bash
wrangler secret put AUTH0_CLIENT_ID
wrangler secret put AUTH0_CLIENT_SECRET
```

## Auth0 studio setup

1. In the Auth0 studio, create a **Regular Web Application** and copy its Client ID + Client Secret.
2. Set the **Allowed Callback URL** to:

    ```
    <BETTER_AUTH_URL>/api/auth/oauth2/callback/auth0
    ```

    e.g. `http://localhost:8787/api/auth/oauth2/callback/auth0` in dev.

3. Note your tenant **domain** (e.g. `your-tenant.us.auth0.com`) for `AUTH0_DOMAIN`. The provider discovers the authorization/token/userinfo endpoints from `https://<domain>/.well-known/openid-configuration`.

## Merge the provider into your auth instance

Add the `auth0` plugin to the `plugins` array in `cirrus/auth/index.ts` (scaffolded by the base item):

```ts
// cirrus/auth/index.ts
import { auth0 } from "./auth0.js";

export const buildAuth = (env: AuthEnv): CirrusAuth =>
    createAuth({
        baseURL: env.BETTER_AUTH_URL,
        database: env.DB as never,
        emailAndPassword: { enabled: true },
        secret: env.BETTER_AUTH_SECRET,
        plugins: [auth0(env)],
    });
```

Widen `AuthEnv` with the Auth0 vars, or import `Auth0Env` from `./auth0.js`. `genericOAuth` contributes no new tables, so no extra migration is needed beyond the base item's schema.

## Sign in from the client

```ts
import { authClient } from "./auth-client";

await authClient.signIn.oauth2({
    providerId: "auth0",
    callbackURL: "/",
});
```

## What you own

`cirrus/auth/auth0.ts` is copied into your repo — change scopes, switch from discovery to explicit `authorizationUrl` / `tokenUrl`, add `mapProfileToUser`, or wire additional providers however you like. `@cirrus/auth` provides the wrapper + the re-exported better-auth plugin; this item is the idiomatic Cirrus glue.
