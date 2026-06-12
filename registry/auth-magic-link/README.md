# auth-magic-link

Passwordless **magic-link** sign-in for Cirrus auth. Wires [better-auth](https://www.better-auth.com)'s [`magicLink`](https://www.better-auth.com/docs/plugins/magic-link) plugin (re-exported by [`@cirrus/auth/plugins`](../../packages/auth)) on top of the base [`auth`](../auth) item, and delivers the sign-in link through [`@cirrus/mail`](../../packages/mail) (captured into the studio Mail tab in dev).

## Install

```bash
cirrus registry add auth-magic-link
```

Because this item declares `requires: ["auth"]`, the registry resolves and installs the base **auth** item first (deps before dependents), then this one. The base item brings `@cirrus/auth` + `@cirrus/mail` + `@cirrus/server`, scaffolds `cirrus/auth/index.ts`, and sets `MAIL_FROM`. This item adds:

1. `@cirrus/auth` and `@cirrus/mail` (both already present from the base item) to `package.json`.
2. `cirrus/auth/magic-link.ts` — the magic-link plugin factory (`magicLinkPlugin(env)`). It's **yours** to edit.

## Merge the plugin into your auth instance

Add `magicLinkPlugin` to the `plugins` array in `cirrus/auth/index.ts` (scaffolded by the base item):

```ts
// cirrus/auth/index.ts
import { magicLinkPlugin } from "./magic-link.js";

export const buildAuth = (env: AuthEnv): CirrusAuth =>
    createAuth({
        baseURL: env.BETTER_AUTH_URL,
        database: env.DB as never,
        emailAndPassword: { enabled: true },
        secret: env.BETTER_AUTH_SECRET,
        plugins: [magicLinkPlugin(env)],
    });
```

`magicLink` contributes no new tables, so no extra migration is needed beyond the base item's schema.

## Mail delivery

The sign-in link is emailed via `@cirrus/mail`'s `createMailerFromEnv`, using `MAIL_FROM` (set by the base **auth** item). In dev every send is captured into the studio's **Mail** tab; for real delivery run `cirrus add email` (adds the `SEND_EMAIL` binding) or set `RESEND_API_KEY`.

## Sign in from the client

```ts
import { authClient } from "./auth-client";

await authClient.signIn.magicLink({
    email: "user@example.com",
    callbackURL: "/",
});
```

## What you own

`cirrus/auth/magic-link.ts` is copied into your repo — change the email subject/body, switch to an HTML template, tune link expiry, or set `disableSignUp` however you like. `@cirrus/auth` provides the wrapper + the re-exported better-auth plugin; this item is the idiomatic Cirrus glue.
