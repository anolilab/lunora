# workos-auth

Lunora with [WorkOS AuthKit](https://workos.com/docs/authkit) as the identity
provider. `@workos-inc/authkit-react` signs users in and owns the session. The
Worker only verifies the AuthKit access token, with `@lunora/jwt-auth`'s
`workos()` preset.

What it shows:

- **Per-user data under RLS.** `lunora/notes.ts` keeps `notes` rows keyed on
  the WorkOS user id. A read policy (`ownerId = auth.userId`) narrows `mine` to
  the caller's rows, and an insert policy stops anyone writing a note they don't
  own.
- **An org/role-gated query.** `orgNotes` returns every note in the caller's
  organization, but only to the `admin` role. The token's `role`/`roles` become
  the identity's `roles`, and `rls(..., { roles: [orgAdmin] })` maps `admin` to
  the `notes:read-org` permission.
- **Token wiring and refresh.** `src/client/workos-token-bridge.tsx` hands
  `useAuth().getAccessToken()` to `LunoraClient.setAuthToken` and refreshes it
  from `onTokenExpired`. AuthKit keeps the access token in memory, not in a
  cookie on your domain, so a bearer is the only way it reaches the API.
- **Authenticated live queries.** The client sets `authTokenOnUpgrade: true`,
  so its WebSockets carry the token as a `Sec-WebSocket-Protocol` entry, never
  in the URL. `useQuery(api.notes.mine)` updates live.
- **No builder sugar.** `src/server/index.ts` sets `resolveIdentity` through
  `defineApp().extend(...)`.

## Setup

1. In the [WorkOS dashboard](https://dashboard.workos.com), enable AuthKit.
2. Under **Redirects**, add `http://localhost:5173` as a redirect URI. Under
   **Authentication → CORS** (allowed origins), add `http://localhost:5173` so
   the browser can refresh tokens.
3. Copy your client id (`client_…`) from **API keys**.
4. To try the org-gated query, create an organization, add your user to it,
   and give the user the `admin` role.
5. Fill in the env files:

    ```bash
    cp .dev.vars.example .dev.vars   # read by the Worker
    cp .env.example .env.local       # read by the browser bundle
    ```

    | File         | Var                        | Value                                 |
    | ------------ | -------------------------- | ------------------------------------- |
    | `.dev.vars`  | `WORKOS_CLIENT_ID`         | `client_…`                            |
    | `.dev.vars`  | `WORKOS_AUTH_DOMAIN`       | optional: your custom auth domain     |
    | `.env.local` | `VITE_WORKOS_CLIENT_ID`    | the same `client_…`                   |
    | `.env.local` | `VITE_WORKOS_API_HOSTNAME` | optional: the same custom auth domain |

    None of these is a secret. Tokens are verified against the public JWKS at
    `https://api.workos.com/sso/jwks/<clientId>`, so the Worker needs no WorkOS
    API key.

6. Run it:

    ```bash
    pnpm install
    pnpm --filter @lunora-example/workos-auth dev
    ```

## Tests

```bash
pnpm --filter @lunora-example/workos-auth test
```

`__tests__/workos-identity.test.ts` needs no WorkOS account. It signs
AuthKit-shaped access tokens with a local key and verifies them through
`workos()`, exactly as the Worker does. The resulting identity then drives the
real procedures on the in-memory harness.

## Notes

- Set the access-token lifetime under **Sessions** in the dashboard. Each
  socket reconnects warm once per lifetime, when the server closes it with
  code 4001.
- `memoizeIdentity` reuses a verification for 5 seconds. That is also how long
  a revoked session keeps working.

Guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
