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

Client, with `@clerk/react`. `setAuthTokenProvider` installs each token with
the user id as its subject, fetches the next one 10 seconds before `exp`, and
refreshes again whenever the server reports an expired token:

```tsx
import { setAuthTokenProvider } from "lunorash/client"; // or "@lunora/client" without the lunorash umbrella

const { getToken, isLoaded, isSignedIn, orgId, userId } = useAuth();
const client = useMemo(() => new LunoraClient({ url: location.origin, authTokenOnUpgrade: true }), []);

useEffect(() => {
    if (!isLoaded) return undefined;
    if (!isSignedIn) return client.setAuthToken(null);

    return setAuthTokenProvider(client, getToken, { subject: userId });
}, [client, getToken, isLoaded, isSignedIn, orgId, userId]);
```

`authTokenOnUpgrade: true` lets live-query sockets carry the token too. A
browser can't set `Authorization` on a WebSocket, so the token travels as a
`Sec-WebSocket-Protocol` entry and never in the URL.

## Identity claims

| Claim            | From (v2 / v1 session token)                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `userId`         | `sub`                                                                               |
| `orgId`          | `o.id` / `org_id`                                                                   |
| `orgRole`        | `org:` + `o.rol` / `org_role` (e.g. `org:admin`)                                    |
| `orgPermissions` | decoded from `fea` + `o.per` + `o.fpm` / `org_permissions` (`org:<feature>:<perm>`) |
| `sessionId`      | `sid`                                                                               |

A `pending` session (`sts`) and a token whose `azp` is not in
`CLERK_AUTHORIZED_PARTIES` resolve to anonymous.

The org role is not copied into `roles`, the app-wide claim RLS role checks
read. It belongs to the active organization, and any Clerk user can create an
organization and become its `org:admin`. Check `orgRole` together with
`orgId` in a policy, or map it to app roles deliberately with the `claims`
option.

## Env vars

| Var                        | Secret | Notes                                                                     |
| -------------------------- | ------ | ------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`    | no     | Your publishable key. It encodes the Frontend API, i.e. the token issuer. |
| `CLERK_AUTHORIZED_PARTIES` | no     | Required. Comma-separated frontend origins, checked against `azp`.        |

No Clerk secret key is needed: tokens are verified against the public JWKS.

## Clerk dashboard setup

1. Create an application and copy the publishable key from **API keys**.
2. Clerk session tokens live for 60 seconds. Each live-query socket therefore
   reconnects about once a minute and resumes from its cursor. Keep using the
   session token rather than a JWT template: Clerk leaves the session-bound
   claims (`sid`, `v`, `fea`, …) out of template tokens, so the session id and
   the organization claims the preset reads are lost. To add claims of your own,
   [customize the session token](https://clerk.com/docs/guides/sessions/customize-session-tokens).
3. To verify with no network call, copy the PEM **JWKS Public Key** from
   **API keys** and pass it to `clerk()` as
   `keySet: await importSPKI(pem, "RS256")` (`importSPKI` is from `jose`).

Full guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
