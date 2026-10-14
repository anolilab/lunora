# auth-clerk

Sign in with [Clerk](https://clerk.com) for Lunora auth. Wires Clerk as an OIDC provider through [better-auth](https://www.better-auth.com)'s [`genericOAuth`](https://www.better-auth.com/docs/plugins/generic-oauth) plugin (also re-exported by [`@lunora/auth/plugins`](../../packages/auth)), on top of the base [`auth`](../auth) item.

This closes the Convex-parity gap for Clerk-style hosted auth (CONVEX-PARITY #15) as a registry item you own and edit — no managed service lock-in beyond Clerk itself.

## Install

```bash
lunora registry add auth-clerk
```

Because this item declares `requires: ["auth"]`, the registry resolves and installs the base **auth** item first (deps before dependents), then this one. The base item brings `@lunora/auth` + `@lunora/server` and scaffolds `lunora/auth/index.ts`; this item adds:

1. `@lunora/auth` (already present from the base item) and `better-auth` to `package.json` — run `pnpm install` once.
2. `lunora/auth/clerk.ts` — the Clerk OIDC provider plugin (`clerk(env)`). It's **yours** to edit.
3. `CLERK_CLIENT_ID`, `CLERK_CLIENT_SECRET`, `CLERK_ISSUER_URL` into your `.dev.vars`.

## Env vars

| Var                   | Secret | Notes                                                                                   |
| --------------------- | ------ | --------------------------------------------------------------------------------------- |
| `CLERK_CLIENT_ID`     | yes    | OAuth client ID from your Clerk application.                                            |
| `CLERK_CLIENT_SECRET` | yes    | OAuth client secret from your Clerk application.                                        |
| `CLERK_ISSUER_URL`    | no     | Clerk OIDC issuer, e.g. `https://your-app.clerk.accounts.dev`. Endpoints are discovered |

Set the secrets in production with Wrangler:

```bash
wrangler secret put CLERK_CLIENT_ID
wrangler secret put CLERK_CLIENT_SECRET
```

## Clerk dashboard setup

1. In the Clerk dashboard, create an **OAuth application** and copy its client ID + secret.
2. Set the redirect / callback URL to:

    ```
    <BETTER_AUTH_URL>/api/auth/oauth2/callback/clerk
    ```

    e.g. `http://localhost:8787/api/auth/oauth2/callback/clerk` in dev.

3. Note your Clerk **issuer URL** (Frontend API / `*.clerk.accounts.dev`) for `CLERK_ISSUER_URL`. The provider discovers the authorization/token/userinfo endpoints from `<issuer>/.well-known/openid-configuration`.

## Merge the provider into your auth instance

Add the `clerk` plugin to the `plugins` array in `lunora/auth/index.ts` (scaffolded by the base item):

```ts
// lunora/auth/index.ts — ADD to what the base `auth` item scaffolded; don't replace it.
import { clerk } from "./clerk.js";

export const buildAuth = (env: AuthEnv): LunoraAuth =>
    createAuth({
        // ... everything the base item already set (baseURL, database, emailAndPassword,
        // emailVerification, secret) stays exactly as it is. In particular keep
        // `database: lunoraD1Adapter(env.DB as never)` — passing raw `env.DB` makes
        // better-auth resolve its Kysely adapter through a runtime `await import(...)`
        // that never settles under the Cloudflare Vite worker runner, hanging every
        // auth request in `lunora dev`.
        plugins: [uiConfig(), clerk(env)],
    });
```

Widen `AuthEnv` with the Clerk vars, or import `ClerkEnv` from `./clerk.js`. `genericOAuth` contributes no new tables, so no extra migration is needed beyond the base item's schema.

## Sign in from the client

```ts
import { authClient } from "./auth-client";

await authClient.signIn.oauth2({
    providerId: "clerk",
    callbackURL: "/",
});
```

## What you own

`lunora/auth/clerk.ts` is copied into your repo — change scopes, switch from discovery to explicit `authorizationUrl` / `tokenUrl`, add `mapProfileToUser`, or wire additional providers however you like. `@lunora/auth` provides the wrapper + the re-exported better-auth plugin; this item is the idiomatic Lunora glue.
