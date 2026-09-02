---
name: lunora-setup-auth
description: Adds authentication to a Lunora app. Use for sign-up/sign-in, email/password,
    OAuth (Clerk, Auth0), magic link, or email OTP via `lunora registry add auth`,
    wiring the auth handler into the Worker, and gating functions on the session.
---

# Lunora Setup Auth

Wire authentication into a Lunora app using the `auth` registry item, which is
built on `@lunora/auth` (a thin wrapper over
[better-auth](https://www.better-auth.com)) with identity **and session** tables
in D1. (`SessionDO` is a standalone TTL'd token store `@lunora/auth` never
calls — don't wire it for auth. The Durable Object option is `LunoraAuthDO` /
`.auth({ namespace })`, which holds the whole better-auth schema.)

## When to Use

- Adding sign-up / sign-in to a Lunora app.
- Adding an OAuth/OIDC provider (Clerk, Auth0), magic link, or email OTP.
- Gating queries/mutations on the signed-in user.

## When Not to Use

- The project has no Lunora backend yet — use `lunora-quickstart` first.
- You only need to read `ctx.auth.userId` in a function and auth is already
  installed — just use it.

## Workflow

1. Add the base `auth` item.
2. Mount the auth request handler in the Worker entry.
3. Configure env vars and the D1 database.
4. (Optional) Layer a provider item (Clerk / Auth0 / magic link / OTP) on top.
5. Gate functions on `ctx.auth.userId`; gate UI with the auth gates/hooks.

## Step 1: Add the base item

```bash
lunora registry add auth
```

This:

1. Adds `@lunora/auth`, `@lunora/mail`, and `@lunora/server` to `package.json`
   (run `pnpm install` afterwards).
2. Copies `lunora/auth/index.ts` — the auth instance (`buildAuth` / `getAuth`)
   and the `/api/auth/*` request handler (`mountAuth`) — into your project. It is
   **yours** to edit.
3. Adds a D1 `DB` binding to `wrangler.jsonc` (better-auth persists
   users/sessions there).
4. Scaffolds `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `MAIL_FROM` into
   `.dev.vars`.

## Step 2: Mount the handler

In your Worker entry, route `/api/auth/*` to the scaffolded handler (see the
generated `lunora/auth/index.ts` README block). `createWorker` handles the rest
of the RPC surface; the auth handler owns the better-auth endpoints.

## Step 3: Env vars and the D1 database

| Var                  | Secret | Notes                                                               |
| -------------------- | ------ | ------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | yes    | Encryption secret, min 32 chars. `openssl rand -base64 32`.         |
| `BETTER_AUTH_URL`    | no     | Public base URL, e.g. `http://localhost:8787` in dev, your domain.  |
| `MAIL_FROM`          | no     | Sender for verification / reset mail. Captured in the dev Mail tab. |

Create the D1 database and paste its id into the `DB` binding in
`wrangler.jsonc`:

```bash
wrangler d1 create my-app-db
```

The better-auth schema (user/session/account/verification tables) is **not**
declared in `lunora/schema.ts` — it is managed by better-auth in D1. In dev,
`ensureMigrated(auth)` auto-applies it; in production prefer
`compileMigrationsSql(auth.options)` piped to `wrangler d1 execute`. Run
`lunora doctor` to confirm the `DB` binding has a real `database_id` (not a
placeholder).

Verification and password-reset emails are **captured into the Lunora Studio
Mail tab** in dev with zero email setup. For real delivery, `lunora registry add
mail` (adds the `SEND_EMAIL` binding) or set `RESEND_API_KEY`.

## Step 4: Add a provider (optional)

Each provider item builds on the base `auth` item (`requires: ["auth"]`):

```bash
lunora registry add auth-clerk        # Clerk via better-auth genericOAuth
lunora registry add auth-auth0        # Auth0 via better-auth genericOAuth
lunora registry add auth-magic-link   # passwordless magic-link (mail)
lunora registry add auth-otp          # passwordless email one-time-password
```

Add the base `auth` item first (or let the registry resolve the `requires`
dependency). OAuth items need the provider's client id/secret added to
`.dev.vars`.

## Step 5: Use the session

### In functions

The runtime resolves the session and exposes the user on every context:

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

For richer checks (org membership, roles), compose `withAuthPlugins(auth)` and
call the better-auth server API — see the scaffolded `lunora/auth/index.ts`.

### In the UI (React)

`useAuth()` returns exactly `{ setToken, token, user }` — there is no `signIn` /
`signOut`. Lunora owns the **token**, not the sign-in flow: run the flow with
the better-auth client (`authClient.signIn.email(...)`), then hand the resulting
JWT to `setToken`. `setToken(null)` signs out.

```tsx
import { Authenticated, Unauthenticated, useAuth } from "@lunora/react";

import { authClient } from "./auth-client";

function Account() {
    const { setToken, user } = useAuth();

    const signIn = async () => {
        const { data } = await authClient.signIn.email({ email, password });

        setToken(data?.token ?? null);
    };

    return (
        <>
            <Authenticated>
                <span>Signed in as {user?.email}</span>
                <button type="button" onClick={() => setToken(null)}>
                    Sign out
                </button>
            </Authenticated>
            <Unauthenticated>
                <button type="button" onClick={signIn}>
                    Sign in
                </button>
            </Unauthenticated>
        </>
    );
}
```

`@lunora/react` also exports `AuthLoading` and `useAuthState` for the loading
window before the session resolves.

## Common Pitfalls

1. **Declaring better-auth tables in `lunora/schema.ts`.** They live in D1 and
   are managed by better-auth — do not add them to `defineSchema`.
2. **Placeholder `database_id`.** The `DB` binding ships with a placeholder;
   `wrangler d1 create` + paste the id, then `lunora doctor` to confirm.
3. **Missing/short `BETTER_AUTH_SECRET`.** better-auth needs ≥32 chars;
   `@lunora/auth` surfaces a clear error when it is absent.
4. **Expecting prod email to "just work".** Dev captures mail into the Studio;
   production needs `mail` (the `SEND_EMAIL` binding) or `RESEND_API_KEY` and a
   verified sender domain.

## Checklist

- [ ] `lunora registry add auth` run, `pnpm install` done.
- [ ] Auth handler mounted in the Worker entry.
- [ ] `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `MAIL_FROM` set in `.dev.vars`.
- [ ] D1 database created and its id pasted into the `DB` binding (`lunora
doctor` clean).
- [ ] Provider item added if needed (Clerk / Auth0 / magic link / OTP).
- [ ] Functions gate on `ctx.auth.userId`; UI uses the auth gates/`useAuth`.
- [ ] Verified sign-in → session → an authenticated query round-trip.
