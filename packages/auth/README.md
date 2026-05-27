# @cirrus/auth

Cookie-session authentication adapter for the Cirrus framework. Built on top of
[`better-auth`](https://www.better-auth.com/), with sessions persisted in the
`SessionDO` shipped by `@cirrus/do` and a D1-backed user store.

```ts
import { createAuth, providers } from "@cirrus/auth";

const auth = createAuth({
    secret: env.AUTH_SECRET,
    providers: [providers.emailPassword(), providers.github({ clientId: env.GITHUB_ID, clientSecret: env.GITHUB_SECRET })],
});

// Mount into the Worker's routes map.
const routes = auth.routes();
```

## Identity inside a Cirrus function

Wire `auth.resolveIdentity` into the runtime so every RPC reaching a `ShardDO`
carries the resolved user:

```ts
import { createWorker } from "@cirrus/runtime";

export default createWorker({
    shardDO: env.SHARD_DO,
    resolveIdentity: (request) => auth.resolveIdentity(request, env),
});
```

`resolveIdentity` returns either `null` (no session) or `{ userId, ...extraClaims }`.
The runtime forwards `userId` on the `x-cirrus-userid` header and, when extra
claims are present, JSON-serialises them onto `x-cirrus-identity`. Inside a
function, `ctx.auth.userId` and `ctx.auth.getIdentity()` give you the resolved
identity — they read from the request the runtime forwarded into the DO.

## Status

- Sessions live in `SessionDO` (one DO per active session) and are mirrored to
  D1 (`auth_sessions`, `auth_users`) so cold reads don't need the DO to be
  warm.
- Password hashing uses PBKDF2 via `crypto.subtle`; OAuth providers complete
  the full PKCE redirect + token-exchange dance.
- Bearer tokens are accepted on both the `Authorization` header and the
  `?token=` query parameter — see the `CIRRUS_WS_BEARER` note in `@cirrus/do`
  for the WebSocket upgrade caveat.
