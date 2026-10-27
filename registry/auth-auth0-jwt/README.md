# auth-auth0-jwt

Use [Auth0](https://auth0.com) as your identity provider and let Auth0 own the
session. Lunora verifies each request's Auth0 access token against your
tenant's JWKS (via [`@lunora/jwt-auth`](../../packages/jwt-auth)) and feeds the
user into `ctx.auth` and RLS.

**Which Auth0 item?**

- `auth-auth0-jwt` (this item): Auth0's SDK handles sign-in and holds the
  session. Lunora only verifies the access token Auth0 issues for your API.
- [`auth-auth0`](../auth-auth0): Auth0 is an OAuth login button for
  `@lunora/auth`. Lunora (better-auth) owns the session in D1.

## Install

```bash
lunora registry add auth-auth0-jwt
```

This adds `@lunora/jwt-auth` to `package.json`, scaffolds
`lunora/identity/auth0.ts` (yours to edit), and writes the env vars below into
`.dev.vars`.

## Wire it

Worker entry:

```ts
import { auth0Identity } from "../../lunora/identity/auth0"; // from src/server/index.ts

createWorker({ resolveIdentity: auth0Identity(env), shardDO: env.SHARD });
```

Client, with `@auth0/auth0-react`. Request your API as the audience, and use
refresh tokens so a silent refresh does not depend on third-party cookies:

```tsx
<Auth0Provider
    domain={AUTH0_DOMAIN}
    clientId={AUTH0_CLIENT_ID}
    authorizationParams={{ audience: AUTH0_AUDIENCE, redirect_uri: location.origin }}
    useRefreshTokens
>
```

```tsx
import { setAuthTokenProvider } from "lunorash/client"; // or "@lunora/client" without the lunorash umbrella

const { getAccessTokenSilently, isAuthenticated, user } = useAuth0();

useEffect(() => {
    if (!isAuthenticated || !user?.sub) return client.setAuthToken(null);

    const fetchToken = async () => {
        try {
            return await getAccessTokenSilently();
        } catch (error) {
            // `login_required` / `missing_refresh_token`: the session is gone.
            const code = (error as { error?: unknown }).error;
            if (code === "login_required" || code === "missing_refresh_token") return null;
            throw error;
        }
    };

    return setAuthTokenProvider(client, fetchToken, { subject: user.sub });
}, [client, getAccessTokenSilently, isAuthenticated, user?.sub]);
```

`authTokenOnUpgrade: true` on the `LunoraClient` lets live-query sockets carry
the token too, as a `Sec-WebSocket-Protocol` entry and never in the URL.

## Identity claims

| Claim         | From                                                            |
| ------------- | --------------------------------------------------------------- |
| `userId`      | `sub`                                                           |
| `permissions` | `permissions` (RBAC with "Add Permissions in the Access Token") |
| `scopes`      | `scope`, split on spaces                                        |
| `orgId`       | `org_id` (Organizations)                                        |

Machine-to-machine and agent tokens (`gty: "client-credentials"`, a
`…@clients` subject, or a `sub_profile` other than `user`) resolve to
anonymous. Pass `allowClientCredentials: true` to `auth0()` to accept them.

Auth0 puts no roles in access tokens. To gate RLS on roles, add them as a
namespaced custom claim from a post-login Action, e.g.
`api.accessToken.setCustomClaim("https://example.com/roles", event.authorization?.roles ?? [])`,
and map that claim to `roles` with the `claims` option. Validate `orgId`
against the organization you expect before trusting it, as Auth0 advises.

## Env vars

| Var              | Secret | Notes                                            |
| ---------------- | ------ | ------------------------------------------------ |
| `AUTH0_DOMAIN`   | no     | Your tenant domain or custom domain (the `iss`). |
| `AUTH0_AUDIENCE` | no     | Your API identifier (the `aud`). Required.       |

No client secret is needed on the Worker: tokens are verified against the
public JWKS.

## Revocation

Auth0 access tokens default to a 24-hour lifetime (86,400 s), and a signed
token stays valid until it expires. Shorten **Token Expiration** on your API
in the Auth0 dashboard so a revoked session stops working sooner.

Full guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
