# auth

Cookie-session authentication for Cirrus — email/password sign-up and sign-in on top of [`@cirrus/auth`](../../packages/auth), a thin wrapper over [better-auth](https://www.better-auth.com). `createAuth(options)` is `betterAuth(options)` with a clearer error when `secret` is missing; every better-auth option (`socialProviders`, `plugins`, `session`, …) passes straight through.

This is the base item. The [`auth-clerk`](../auth-clerk) and [`auth-auth0`](../auth-auth0) items build on it (`requires: ["auth"]`) to wire those identity providers.

## Install

```bash
cirrus registry add auth
```

This:

1. Adds `@cirrus/auth` and `@cirrus/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `cirrus/auth/index.ts` — the auth instance (`buildAuth` / `getAuth`) and the `/api/auth/*` request handler (`mountAuth`) — into your project. It's **yours** to edit.
3. Scaffolds `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` into your `.dev.vars`.

## Configure env vars

| Var                  | Secret | Notes                                                                      |
| -------------------- | ------ | -------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | yes    | Encryption secret, min 32 chars. Generate with `openssl rand -base64 32`.  |
| `BETTER_AUTH_URL`    | no     | Public base URL, e.g. `http://localhost:8787` in dev, your domain in prod. |

In dev these live in `.dev.vars`. For production set the secret with Wrangler:

```bash
wrangler secret put BETTER_AUTH_SECRET
```

`buildAuth` also reads a `DB` binding — your D1 database, declared in `wrangler.jsonc`. better-auth persists `user` / `session` / `account` / `verification` rows there.

## Wire it up

Mount the auth routes **first** in your Worker's `fetch`, before your app dispatch:

```ts
// src/server/index.ts
import { mountAuth } from "../../cirrus/auth/index.js";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const authResponse = await mountAuth(env, request);
        if (authResponse) return authResponse;

        // …your existing Cirrus worker dispatch…
    },
};
```

To resolve the signed-in user inside Cirrus procedures, pass `resolveIdentity` to `createWorker` and call the auth API there:

```ts
import { getAuth } from "../../cirrus/auth/index.js";

createWorker({
    d1: env.DB,
    resolveIdentity: async (request) => {
        const session = await getAuth(env).api.getSession({ headers: request.headers });
        return session?.user ? { userId: session.user.id } : null;
    },
    // …
});
```

## Apply the database schema

better-auth needs its tables (`user`, `session`, `account`, `verification`) in your D1 database.

**Dev** — `mountAuth` calls `ensureMigrated(auth)` on the first auth request, which diffs the live schema and applies only the missing DDL (idempotent, single-flight). Nothing else to do.

**Production** — prefer pre-applying the schema at deploy time rather than diffing on every cold start. Compile the SQL and pipe it to Wrangler:

```ts
// scripts/auth-migrate.ts
import { compileMigrationsSql } from "@cirrus/auth";

import { buildAuth } from "../cirrus/auth/index.js";

const sql = await compileMigrationsSql(buildAuth(process.env as never).options);
process.stdout.write(sql);
```

```bash
tsx scripts/auth-migrate.ts | wrangler d1 execute <DB_NAME> --remote --file -
```

Then drop the `ensureMigrated` call from `mountAuth` so production doesn't pay the per-cold-start diff.

> Re-run the migration whenever you add a better-auth plugin that contributes new tables (e.g. `organization`, `twoFactor`) — `ensureMigrated` / `compileMigrationsSql` pick the new DDL up automatically.

## Use it from the client

better-auth ships framework clients. For React:

```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ baseURL: import.meta.env.VITE_BETTER_AUTH_URL });

// authClient.signUp.email(...), authClient.signIn.email(...), authClient.useSession(), …
```

## Add OAuth / social providers

`createAuth` forwards `socialProviders` and `plugins` to better-auth. For first-class providers (Google, GitHub, …) add a `socialProviders` block in `buildAuth`. For Clerk / Auth0 (OIDC), add the dedicated registry items:

```bash
cirrus registry add auth-clerk
cirrus registry add auth-auth0
```

## What you own

Everything under `cirrus/auth/` is copied into your repo — change the providers, session policy, plugins, or the handler wiring however you like. `@cirrus/auth` provides the wrapper + helpers; this item is the idiomatic Cirrus glue around them.
