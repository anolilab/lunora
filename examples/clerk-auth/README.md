# clerk-auth

Lunora with [Clerk](https://clerk.com) as the identity provider. Clerk's React
SDK signs users in and owns the session. The Worker only verifies Clerk's
session token, with `@lunora/jwt-auth`'s `clerk()` preset, and Lunora never
stores a password or a session.

What it shows:

- **Per-user data under RLS.** `lunora/notes.ts` keeps `notes` rows keyed on
  the Clerk user id. A read policy (`ownerId = auth.userId`) narrows `mine` to
  the caller's rows, and an insert policy stops anyone writing a note they don't
  own.
- **An org/role-gated query.** `orgNotes` returns every note in the caller's
  active Clerk organization, but only to the org `admin` role. The role arrives
  as `roles: [o.rol]` on the identity, and `rls(..., { roles: [orgAdmin] })`
  maps it to the `notes:read-org` permission.
- **Token wiring and refresh.** `src/client/clerk-token-bridge.tsx` hands
  `useAuth().getToken()` to `LunoraClient.setAuthToken` and refreshes it from
  `onTokenExpired`.
- **Authenticated live queries.** The client sets `authTokenOnUpgrade: true`,
  so its WebSockets carry the token as a `Sec-WebSocket-Protocol` entry, never
  in the URL. `useQuery(api.notes.mine)` updates live.
- **No builder sugar.** `src/server/index.ts` sets `resolveIdentity` through
  `defineApp().extend(...)`.

## Setup

1. Create an application in the [Clerk dashboard](https://dashboard.clerk.com).
   To try the org-gated query, enable **Organizations** too.
2. Copy the publishable key from **Configure → API keys**.
3. Fill in the env files:

    ```bash
    cp .dev.vars.example .dev.vars   # read by the Worker
    cp .env.example .env.local       # read by the browser bundle
    ```

    | File         | Var                          | Value                                                       |
    | ------------ | ---------------------------- | ----------------------------------------------------------- |
    | `.dev.vars`  | `CLERK_PUBLISHABLE_KEY`      | `pk_test_…`                                                 |
    | `.dev.vars`  | `CLERK_AUTHORIZED_PARTIES`   | `http://localhost:5173` (comma-separate production origins) |
    | `.env.local` | `VITE_CLERK_PUBLISHABLE_KEY` | the same `pk_test_…`                                        |

    None of these is a secret. Tokens are verified against Clerk's public JWKS,
    so the Worker needs no Clerk secret key.

4. Run it:

    ```bash
    pnpm install
    pnpm --filter @lunora-example/clerk-auth dev
    ```

To see the org gate, create an organization, switch to it with the
`OrganizationSwitcher`, add a note as a member, and read it as an admin.

## Tests

```bash
pnpm --filter @lunora-example/clerk-auth test
```

`__tests__/clerk-identity.test.ts` needs no Clerk account. It signs v2 session
tokens with a local key and verifies them through `clerk()`, exactly as the
Worker does. The resulting identity then drives the real procedures on the
in-memory harness.

## Notes

- Clerk session tokens expire after 60 seconds. When one lapses, the server
  closes the socket with code 4001 and the client reconnects warm with a fresh
  token, resuming from its cursor. That happens about once a minute per socket.
  To reduce it, issue tokens from a longer-lived Clerk JWT template.
- `memoizeIdentity` reuses a verification for 5 seconds. That is also how long
  a revoked session keeps working.

Guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
