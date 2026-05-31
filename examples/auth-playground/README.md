# @cirrus-example/auth-playground

End-to-end demo of the better-auth plugins Cirrus re-exports under
`@cirrus/auth/plugins` — `organization` and `admin`. Sign up, create an
organization, invite a member, then ban a user from the admin panel.

## What it demonstrates

- Wiring `createAuth(...)` with the `organization()` and `admin()` plugins
  in `cirrus/auth.ts`.
- Routing `/api/auth/*` to better-auth via `handleAuthRequest` in
  `src/server/index.ts` while letting everything else fall through to
  Cirrus's RPC router.
- Pre-deploy schema setup with `ensureMigrated(auth)` against the D1
  binding (use `compileMigrationsSql` + `wrangler d1 execute` in CI).
- An org-scoped table (`documents`) with handlers that gate by membership
  via the better-auth `getActiveMember` endpoint.
- Browser flows: sign-up, create-org, invite-member, admin ban/unban.

## Run it

```bash
pnpm install
pnpm --filter @cirrus-example/auth-playground dev
```

That spins up Vite + Wrangler in Miniflare; open <http://localhost:5173>.

Before deploying to a real Cloudflare account:

1. Create a D1 database: `wrangler d1 create cirrus-auth-playground`.
2. Drop the returned `database_id` into `wrangler.jsonc`.
3. Apply better-auth's schema:

    ```bash
    pnpm tsx -e "import('@cirrus/auth').then(async ({ compileMigrationsSql, createAuth }) => { const sql = await compileMigrationsSql({ database: undefined, secret: 'placeholder' }); console.log(sql); })" \
      > schema.sql
    wrangler d1 execute cirrus-auth-playground --file schema.sql
    ```

4. Set the auth secret: `wrangler secret put AUTH_SECRET`.

## Layout

```
cirrus/
  auth.ts                 createAuth({ plugins: [organization(), admin()] })
  documents.ts            org-scoped query + mutation, gated by membership
  schema.ts               documents table (auth tables are managed by better-auth)
  _generated/             cirrus codegen output (api, dataModel, server, shard, drizzle)
src/
  server/index.ts         worker entry — routes /api/auth/* + Cirrus RPC
  client/auth-client.ts   browser SDK with the matching plugin clients
  client/main.tsx         bootstraps <CirrusProvider> + <App>
  client/App.tsx          sign-up, org create/invite, admin ban panel
```

## Polar billing?

Intentionally not bundled. If you need it:

```bash
pnpm add @polar-sh/better-auth
```

then add `polar({ accessToken: env.POLAR_TOKEN })` to the `plugins:` list in
`cirrus/auth.ts`. The same migration story applies — `ensureMigrated` will
pick up Polar's tables on the next boot.
