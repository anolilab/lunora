# auth-workos-jwt

Use [WorkOS AuthKit](https://workos.com/docs/authkit) as your identity provider.
Lunora verifies each request's AuthKit access token against your client's JWKS
(via [`@lunora/jwt-auth`](../../packages/jwt-auth)) and feeds the user into
`ctx.auth` and RLS.

## Install

```bash
lunora registry add auth-workos-jwt
```

This adds `@lunora/jwt-auth` to `package.json`, scaffolds
`lunora/identity/workos.ts` (yours to edit), and writes `WORKOS_CLIENT_ID` into
`.dev.vars`.

## Wire it

Worker entry:

```ts
import { workosIdentity } from "../../lunora/identity/workos"; // from src/server/index.ts

createWorker({ resolveIdentity: workosIdentity(env), shardDO: env.SHARD });
```

Client, with `@workos-inc/authkit-react`. `setAuthTokenProvider` installs each
token with the user id as its subject, fetches the next one 10 seconds before
`exp`, and refreshes again whenever the server reports an expired token:

```tsx
import { setAuthTokenProvider } from "@lunora/client";
import { LoginRequiredError, useAuth } from "@workos-inc/authkit-react";

const { getAccessToken, isLoading, organizationId, user } = useAuth();
const client = useMemo(() => new LunoraClient({ url: location.origin, authTokenOnUpgrade: true }), []);

useEffect(() => {
    if (isLoading) return undefined;
    if (!user) return client.setAuthToken(null);

    const fetchToken = async () => {
        try {
            return await getAccessToken();
        } catch (error) {
            if (error instanceof LoginRequiredError) return null; // signed out
            throw error;
        }
    };

    return setAuthTokenProvider(client, fetchToken, { subject: user.id });
}, [client, getAccessToken, isLoading, organizationId, user]);
```

The access token reaches the API only as a bearer. `authTokenOnUpgrade: true`
covers the live-query sockets too: the browser offers the token as a
`Sec-WebSocket-Protocol` entry, never in the URL.

Where authkit-react keeps the refresh token depends on the host. On
`localhost` it runs in `devMode` and uses `localStorage`. In production, set
`apiHostname` to a custom authentication domain you own; the refresh token is
then a cookie on that domain.

## Identity claims

| Claim                          | From                                  |
| ------------------------------ | ------------------------------------- |
| `userId`                       | `sub`                                 |
| `orgId`                        | `org_id`                              |
| `role` / `orgRoles`            | `role` / `roles` (the org membership) |
| `permissions`                  | `permissions`                         |
| `entitlements`, `featureFlags` | `entitlements`, `feature_flags`       |
| `sessionId`                    | `sid`                                 |
| `impersonator`                 | `act.sub`, while impersonating        |

Only user access tokens resolve: a token needs `sid` and `auth_time`, and one
carrying a non-user `sub_profile` (an agent) or a `sub_type` (a widget), or
another client's `client_id`, resolves to anonymous.

The role and permissions belong to the active organization, so they are not
copied into `roles`, the app-wide claim RLS role checks read. Check them
together with `orgId` in a policy, or map them deliberately with the `claims`
option.

## Env vars

| Var                  | Secret | Notes                                                                     |
| -------------------- | ------ | ------------------------------------------------------------------------- |
| `WORKOS_CLIENT_ID`   | no     | Your client id. It names the JWKS (`<host>/sso/jwks/<clientId>`).         |
| `WORKOS_AUTH_DOMAIN` | no     | Optional. Your custom auth domain; must match the client's `apiHostname`. |

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
