# auth-workos

Use [WorkOS AuthKit](https://workos.com/docs/authkit) as your identity provider.
Lunora verifies each request's AuthKit access token against your client's JWKS
(via [`@lunora/jwt-auth`](../../packages/jwt-auth)) and feeds the user into
`ctx.auth` and RLS.

## Install

```bash
lunora registry add auth-workos
```

This adds `@lunora/jwt-auth` to `package.json`, scaffolds
`lunora/identity/workos.ts` (yours to edit), and writes `WORKOS_CLIENT_ID` into
`.dev.vars`.

## Wire it

Worker entry:

```ts
import { workosIdentity } from "../lunora/identity/workos";

createWorker({ resolveIdentity: workosIdentity(env), shardDO: env.SHARD });
```

Client, with `@workos-inc/authkit-react`:

```tsx
const { getAccessToken, user } = useAuth();
const client = useMemo(() => new LunoraClient({ url: location.origin, authTokenOnUpgrade: true }), []);

useEffect(() => {
    if (!user) return client.setAuthToken(null);
    void getAccessToken().then((token) => client.setAuthToken(token));
    return client.onTokenExpired(() => void getAccessToken().then((token) => client.setAuthToken(token)));
}, [client, getAccessToken, user]);
```

AuthKit keeps the access token in memory, not in a cookie on your domain, so
the token has to travel as a bearer. `authTokenOnUpgrade: true` covers the
live-query sockets too: the browser offers the token as a
`Sec-WebSocket-Protocol` entry, never in the URL.

## Identity claims

| Claim                          | From                                   |
| ------------------------------ | -------------------------------------- |
| `userId`                       | `sub`                                  |
| `orgId`                        | `org_id`                               |
| `role` / `roles`               | `role` / `roles` (`roles` read by RLS) |
| `permissions`                  | `permissions`                          |
| `entitlements`, `featureFlags` | `entitlements`, `feature_flags`        |
| `sessionId`                    | `sid`                                  |
| `impersonator`                 | `act.sub`, while impersonating         |

A token whose `client_id` is another client's resolves to anonymous.

## Env vars

| Var                  | Secret | Notes                                                                     |
| -------------------- | ------ | ------------------------------------------------------------------------- |
| `WORKOS_CLIENT_ID`   | no     | Your client id. It names the JWKS (`api.workos.com/sso/jwks/<clientId>`). |
| `WORKOS_AUTH_DOMAIN` | no     | Optional. Your custom auth domain, which then issues the tokens.          |

No WorkOS API key is needed on the Worker: tokens are verified against the
public JWKS.

## WorkOS dashboard setup

1. Enable AuthKit and add your app's redirect URI (e.g.
   `http://localhost:5173/callback`) under **Redirects**.
2. Add your app's origin to **CORS / allowed origins** so authkit-react can
   refresh from the browser.
3. Set the access-token lifetime under **Sessions**. Each live-query socket
   reconnects once per token lifetime and resumes from its cursor.

Full guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
