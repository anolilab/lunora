# auth-clerk-jwt

Use [Clerk](https://clerk.com) as your identity provider and let Clerk own the
session. Lunora verifies each request's Clerk session token against your
instance's JWKS (via [`@lunora/jwt-auth`](../../packages/jwt-auth)) and feeds the
user into `ctx.auth` and RLS.

**Which Clerk item?**

- `auth-clerk-jwt` (this item): Clerk's SDK handles sign-in and holds the
  session. Lunora only verifies Clerk's token. No auth tables and no
  better-auth.
- [`auth-clerk`](../auth-clerk): Clerk is an OAuth login button for
  `@lunora/auth`. Lunora (better-auth) owns the session in D1.

## Install

```bash
lunora registry add auth-clerk-jwt
```

This adds `@lunora/jwt-auth` to `package.json`, scaffolds
`lunora/identity/clerk.ts` (yours to edit), and writes the env vars below into
`.dev.vars`.

## Wire it

Worker entry:

```ts
import { clerkIdentity } from "../../lunora/identity/clerk"; // from src/server/index.ts

createWorker({ resolveIdentity: clerkIdentity(env), shardDO: env.SHARD });
```

Client, with `@clerk/react`:

```tsx
const { getToken, isSignedIn } = useAuth();
const client = useMemo(() => new LunoraClient({ url: location.origin, authTokenOnUpgrade: true }), []);

useEffect(() => {
    if (!isSignedIn) return client.setAuthToken(null);
    void getToken().then((token) => client.setAuthToken(token));
    return client.onTokenExpired(() => void getToken().then((token) => client.setAuthToken(token)));
}, [client, getToken, isSignedIn]);
```

`authTokenOnUpgrade: true` lets live-query sockets carry the token too. A
browser can't set `Authorization` on a WebSocket, so the token travels as a
`Sec-WebSocket-Protocol` entry and never in the URL.

## Identity claims

| Claim            | From (v2 / v1 session token)                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `userId`         | `sub`                                                                               |
| `orgId`          | `o.id` / `org_id`                                                                   |
| `orgRole`        | `o.rol` / `org_role` without `org:`                                                 |
| `orgPermissions` | decoded from `fea` + `o.per` + `o.fpm` / `org_permissions` (`org:<feature>:<perm>`) |
| `roles`          | `[orgRole]`, read by RLS                                                            |
| `sessionId`      | `sid`                                                                               |

A `pending` session (`sts`) and a token whose `azp` is not in
`CLERK_AUTHORIZED_PARTIES` resolve to anonymous.

## Env vars

| Var                        | Secret | Notes                                                                     |
| -------------------------- | ------ | ------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`    | no     | Your publishable key. It encodes the Frontend API, i.e. the token issuer. |
| `CLERK_AUTHORIZED_PARTIES` | no     | Comma-separated frontend origins, checked against `azp`.                  |

No Clerk secret key is needed: tokens are verified against the public JWKS.

## Clerk dashboard setup

1. Create an application and copy the publishable key from **API keys**.
2. Clerk session tokens live for 60 seconds. Each live-query socket therefore
   reconnects about once a minute and resumes from its cursor. If that churn
   matters, issue a longer-lived token from a
   [JWT template](https://clerk.com/docs/guides/sessions/jwt-templates) and pass
   `getToken({ template })`. The template's `iss` and JWKS are the same.

Full guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
