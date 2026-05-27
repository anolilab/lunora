# @cirrus/auth

Cookie-session authentication adapter for the Cirrus framework. v0.1 ships a minimal in-house surface (email/password + OAuth provider scaffolding) backed by D1 tables and PBKDF2 password hashing via `crypto.subtle`. A future v0.2 will swap the internals for [`better-auth`](https://www.better-auth.com/) without changing the public API.

```ts
import { createAuth, providers } from "@cirrus/auth";

const auth = createAuth({
    secret: env.AUTH_SECRET,
    providers: [providers.emailPassword(), providers.github({ clientId: env.GITHUB_ID, clientSecret: env.GITHUB_SECRET })],
});

// Mount into the Worker's routes map.
const routes = auth.routes();
```

## Status

- Sessions live in D1 (`auth_sessions`, `auth_users`); the planned `SessionDO` pinning lands in v0.2.
- OAuth providers stub the provider-side token exchange so end-to-end tests stay green without external calls. The PKCE redirect dance is implemented; the token call is marked with a `TODO`.
