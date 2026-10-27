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
- **An org-gated query.** `orgNotes` returns every note in the caller's
  organization, but only to members whose role grants `notes:read-org`. The
  identity carries the org's `role`, `orgRoles` and `permissions` next to
  `orgId`, and the policy checks them together. They are never turned into
  app-wide RLS roles, since they belong to one organization.
- **Token wiring and refresh.** `src/client/workos-token-bridge.tsx` hands
  `useAuth().getAccessToken` to `setAuthTokenProvider` from `lunorash/client`,
  which installs each token with the user id as its subject, fetches the next
  one ten seconds before `exp`, and refreshes again from `onTokenExpired`. A
  `LoginRequiredError` means signed out. The access token reaches the API only
  as a bearer.
- **Authenticated live queries.** The client sets `authTokenOnUpgrade: true`,
  so its WebSockets carry the token as a `Sec-WebSocket-Protocol` entry, never
  in the URL. `useQuery(api.notes.mine)` updates live.
- **No builder sugar.** `src/server/index.ts` sets `resolveIdentity` through
  `defineApp().extend(...)`.

## Setup

1. In the [WorkOS dashboard](https://dashboard.workos.com), enable AuthKit.
2. Under **Redirects**, add `http://localhost:5173` as a redirect URI. Under
   **Authentication → CORS** (allowed origins), add `http://localhost:5173` so
   the browser can refresh tokens. `5173` is the default dev port; in a linked
   git worktree `pnpm dev` prints a shifted one, and that origin is the one to
   register.
3. Copy your client id (`client_…`) from **API keys**.
4. To try the org-gated query, under **Authorization** create a permission
   with the slug `notes:read-org` and add it to the `admin` role (WorkOS puts
   a role's permissions in the access token's `permissions` claim, which is
   what the policy checks). Then create an organization, add your user to it,
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
    `https://<api.workos.com or your auth domain>/sso/jwks/<clientId>`, so the
    Worker needs no WorkOS API key. `WORKOS_AUTH_DOMAIN` and
    `VITE_WORKOS_API_HOSTNAME` must name the same host: the browser gets its
    tokens from `apiHostname`, and the Worker expects that host in `iss`.

    On `localhost`, authkit-react runs in `devMode` and keeps the refresh token
    in `localStorage`. In production, set `apiHostname` to a custom
    authentication domain you own, so the refresh token can live in a cookie
    on your domain instead.

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
  refresh reconnects the sockets warm, once per lifetime. If a refresh comes
  too late, the server closes the socket with code 4001 and the same
  reconnect follows.
- `memoizeIdentity` reuses a verification for 5 seconds. That is also how long
  a revoked session keeps working.

Guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
