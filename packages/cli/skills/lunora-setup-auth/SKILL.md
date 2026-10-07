---
name: lunora-setup-auth
description: Adds authentication to a Lunora app with the `auth` registry item (better-auth via `@lunora/auth`, users and sessions in D1). Covers email/password sign-up and sign-in, Clerk or Auth0 OAuth, magic link, email OTP, copy-in auth screens (`lunora add auth-ui`), wiring `/api/auth/*` and `resolveIdentity` into the Worker, and gating functions on `ctx.auth.userId`. Use when the user asks to "add auth", "add login/sign-in/sign-up", "protect this query", or "add Clerk/Auth0/magic link/OTP", runs `lunora add auth` or `lunora registry add auth`, edits `lunora/auth/index.ts`, or `ctx.auth.userId` is unexpectedly `null`.
---

# Lunora Setup Auth

The `auth` registry item is built on `@lunora/auth`, a thin wrapper over
[better-auth](https://www.better-auth.com). Users and sessions are stored in D1.
Lunora's `SessionDO` is a separate TTL'd token store that `@lunora/auth` never
calls, so don't wire it for auth. If you need auth state in a Durable Object
instead of D1, use `LunoraAuthDO` / `.auth({ namespace, internalSecret })`.

If the project has no Lunora backend yet, start with `lunora-quickstart`.

## Step 1: Add the item

```bash
lunora add auth                      # asks for the provider and D1 database name
lunora add auth --provider clerk --db my-app-db   # non-interactive (auth | clerk | auth0)
lunora registry add auth             # low-level: writes placeholder names
```

Then run `pnpm install`. The item does the following:

1. Adds `@lunora/auth`, `@lunora/mail` and `@lunora/server` to `package.json`.
2. Copies `lunora/auth/index.ts` into the project. The project owns this file and can edit it. It exports `buildAuth(env)`, `getAuth(env)` (memoized per isolate) and `mountAuth(env, request)`, which routes `/api/auth/*` and returns `undefined` for any other path. The scaffold turns on email/password with `requireEmailVerification: true` and sends verification and reset mail through `@lunora/mail`. It also adds the `uiConfig()` plugin.
3. Adds a D1 `DB` binding to `wrangler.jsonc`. The `database_id` is a placeholder.
4. Writes `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `MAIL_FROM` to `.dev.vars`.

## Step 2: Database and env vars

| Var                  | Secret | Notes                                                                             |
| -------------------- | ------ | --------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | yes    | At least 32 chars (`openssl rand -base64 32`). Production: `wrangler secret put`. |
| `BETTER_AUTH_URL`    | no     | Public base URL. better-auth uses it for callbacks and cookies.                   |
| `MAIL_FROM`          | no     | Sender for verification and reset mail.                                           |

```bash
wrangler d1 create my-app-db   # paste the returned id into the DB binding
lunora doctor                  # flags a placeholder database_id
```

Don't declare the better-auth tables (`user`, `session`, `account`,
`verification`) in `lunora/schema.ts`. better-auth owns them in D1. In dev the
schema is auto-applied on the first `/api/auth/*` request. For production,
pre-apply it with `compileMigrationsSql(auth.options)` piped to
`wrangler d1 execute <db> --remote --file -`. The item README has the script.
Re-run that migration after adding a plugin that brings its own tables, such as
`organization` or `twoFactor`.

## Step 3: Wire the Worker

There are two parts. `/api/auth/*` has to reach better-auth. `resolveIdentity`
has to turn the session cookie into `ctx.auth`. If `resolveIdentity` is missing,
sign-in still works but `ctx.auth.userId` stays `null` in every function.

**Through the generated `defineApp` builder.** This is the default for
templates. `.auth()` does both parts: it builds the instance lazily, runs
`ensureMigrated`, dispatches `/api/auth/*` and sets `resolveIdentity`. A
Vite-first app (`"main": "virtual:lunora/worker"`) has no entry file, so chain
the call in the `lunora.config.ts` `app` hook. A hand-written entry
(`src/server.ts`) chains it on `defineApp()` directly:

```ts
// lunora.config.ts
import type { AppBuilder, LunoraConfig } from "./lunora/_generated/app";
// Move the object `buildAuth` passes to `createAuth` (minus `database`; the
// builder supplies the D1 adapter) into an exported `authOptions(env)` in
// lunora/auth/index.ts, and have `buildAuth` spread it too.
import { authOptions } from "./lunora/auth/index.js";

interface Env {
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    DB: D1Database;
}

export default {
    target: "cloudflare",
    app: (app: AppBuilder<Env>): AppBuilder<Env> =>
        app.auth({
            d1: (env) => env.DB,
            options: (env) => authOptions(env),
        }),
} satisfies LunoraConfig<Env>;
```

Reuse the scaffold's options rather than retyping a subset: a hand-written
`{ emailAndPassword: { enabled: true } }` drops `requireEmailVerification`,
`sendResetPassword` and `sendVerificationEmail`, so users sign in unverified and
no verification or reset mail goes out.

`.auth()` appears on the builder only after codegen sees `@lunora/auth`
installed, so run `lunora codegen` first.

**Hand-rolled `createWorker` entry.** Call the scaffolded `mountAuth` first in
`fetch`, then hand every other request to the Lunora worker, which resolves the
identity:

```ts
import type { AuthEnv } from "../../lunora/auth/index.js";
import { getAuth, mountAuth } from "../../lunora/auth/index.js";

const worker = createWorker({
    resolveIdentity: async (req, env) => {
        const session = await getAuth(env as AuthEnv).api.getSession({ headers: req.headers });
        return session?.user ? { userId: session.user.id } : null;
    },
    // …
});

export default {
    async fetch(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
        const authResponse = await mountAuth(env, request);
        if (authResponse) return authResponse;
        return worker.fetch(request, env, ctx); // RPC, WebSocket, everything else
    },
};
```

## Step 4: Providers and add-ons (optional)

Each of these items requires the base `auth` item and installs it if it is
missing:

```bash
lunora add auth-clerk        # Clerk OIDC (genericOAuth): CLERK_CLIENT_ID / _SECRET / CLERK_ISSUER_URL
lunora add auth-auth0        # Auth0 OIDC: AUTH0_CLIENT_ID / _SECRET / AUTH0_DOMAIN
lunora add auth-magic-link   # passwordless link, sent via @lunora/mail
lunora add auth-otp          # email one-time code, sent via @lunora/mail
lunora add auth-emails       # styled React templates for the auth mails (renderEmail)
lunora add auth-ui           # copy-in screens; framework auto-detected (no React Native port)
```

The provider items copy a file into `lunora/auth/` but don't register it
anywhere. Add the plugin to the `plugins` array yourself, in `buildAuth` or in
`.auth({ options })`. For example, `plugins: [uiConfig(), clerk(env)]` with
`import { clerk } from "./clerk.js"`. The other exports are `auth0`,
`magicLinkPlugin` and `emailOtpPlugin`. The OAuth callback URL is
`<BETTER_AUTH_URL>/api/auth/oauth2/callback/<clerk|auth0>`.

## Step 5: Use the session

### In functions

```ts
import { LunoraError } from "lunorash/server";

import { mutation, v } from "#lunora/_generated/server.js";

export const createDocument = mutation.input({ title: v.string() }).mutation(async ({ ctx, args: { title } }) => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }
    return ctx.db.insert("documents", { ownerId: ctx.auth.userId, title, createdAt: Date.now() });
});
```

`ctx.auth.getIdentity()` returns the full session claims, such as email and
name. For org or role checks, compose `withAuthPlugins(auth)` and call the
better-auth server API.

### In the client

The default is a better-auth **cookie session**. `LunoraClient` needs no token,
so don't call `setToken` / `setAuthToken` for it. Sign in with the better-auth
client. Build that client with `createLunoraAuthClient`, which installs
`lunoraSessionSync()`. That plugin tells every open `LunoraClient`, including
ones in other tabs, to re-resolve the session after sign-in or sign-out. Without
it, live queries keep serving the previous user's rows. If you call
`createAuthClient` yourself, add `lunoraSessionSync()` to its plugins.

```tsx
import { createLunoraAuthClient } from "@lunora/auth/plugins/client";
import { Authenticated, AuthLoading, Unauthenticated, useAuth } from "@lunora/react";
import { createAuthClient } from "better-auth/react";

export const authClient = createLunoraAuthClient(createAuthClient);

function Account({ email, password }: { email: string; password: string }) {
    const { user } = useAuth(); // { setToken, status, token, user }

    return (
        <>
            <AuthLoading>…</AuthLoading>
            <Authenticated>
                <span>Signed in as {user?.email}</span>
                <button type="button" onClick={() => authClient.signOut()}>
                    Sign out
                </button>
            </Authenticated>
            <Unauthenticated>
                <button type="button" onClick={() => authClient.signIn.email({ email, password })}>
                    Sign in
                </button>
            </Unauthenticated>
        </>
    );
}
```

A client plugin toggle such as `{ plugins: { twoFactor: true } }` only adds
the client half. Register the matching server plugin (`twoFactor()` from
`@lunora/auth/plugins`) in `buildAuth`'s `plugins` too, or its endpoints don't
exist.

`setToken` is only for bearer-token setups, such as React Native or a JWT from
an external IdP.

Branch on `status`, not on `user === null`. `status` takes one of four values:
`"unauthenticated"`, `"loading"`, `"authenticated"` or `"unreachable"`. The gates
in `@lunora/vue`, `@lunora/solid`, `@lunora/svelte` and `@lunora/angular` use the
same four. `"unreachable"` means a credential is held but the session endpoint
failed, for example on an offline reload. The gates treat it as authenticated,
yet `user` can still be `null` at that point. A UI that reads that `null` as
"signed out" shows a signed-in user the signed-out screen. The full contract is
documented on `AuthStatus` in `@lunora/client/auth`.

## Pitfalls

- **Sign-in rejected right after sign-up.** The scaffold sets `requireEmailVerification: true`, so the user has to open the verification link first. In dev, that link is in the Studio Mail tab.
- **Mail in production.** Dev captures mail into the Studio. In production with no `MAIL_FROM`, the scaffold throws rather than logging the link. Auth links are bearer credentials, so this is intentional. Production needs `lunora add email` (the `SEND_EMAIL` binding) or `RESEND_API_KEY`, plus a verified sender domain. See `lunora-setup-mail`.
- **Unauthenticated storage or other items.** Items that call `requireOwner` throw `UNAUTHORIZED` until `resolveIdentity` is wired (Step 3).

## Verify

1. Run `lunora doctor`. It should report no placeholder `database_id`.
2. Run `lunora dev`. Sign up, open the verification link from the Studio Mail tab, then sign in.
3. Call a query that returns `ctx.auth.userId`. It should return the user's id, not `null`.
