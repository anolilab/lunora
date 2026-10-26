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
- **An org-gated query.** `orgNotes` returns every note in the caller's
  active Clerk organization, but only to its admins. The identity carries the
  org role as `orgRole: "org:admin"` next to `orgId`, and the policy checks the
  two together. The org role is never turned into an app-wide RLS role: any
  Clerk user can create an organization and become its admin.
- **Token wiring and refresh.** `src/client/clerk-token-bridge.tsx` hands
  `useAuth().getToken` to `setAuthTokenProvider` from `lunorash/client`, which
  installs each token with the user id as its subject, fetches the next one ten
  seconds before `exp`, and refreshes again from `onTokenExpired`.
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

- Clerk session tokens expire after 60 seconds. Each refresh reconnects the
  sockets warm with the new token, resuming from their cursors, so that
  happens about once a minute per socket. If a refresh comes too late, the
  server closes the socket with code 4001 and the same reconnect follows.
  Keep using the session token: Clerk leaves the session-bound claims
  (`sid`, `v`, `fea`, …) out of JWT template tokens, and the preset relies on
  them. To add claims, customize the session token instead
  (https://clerk.com/docs/guides/sessions/customize-session-tokens).
- `CLERK_AUTHORIZED_PARTIES` is required. An empty value stops the Worker at
  startup, because Clerk warns that skipping the `azp` check opens the app to
  CSRF.
- `memoizeIdentity` reuses a verification for 5 seconds. That is also how long
  a revoked session keeps working.

Guide: [External auth](https://lunora.sh/docs/concepts/external-auth).
