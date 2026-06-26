# @lunora/playground

A real-time chat app that exercises every part of Lunora v0.1 — sharded
Durable Objects, D1, R2 signed URLs, email/password auth, and the scheduler.

It doubles as the v0.1 smoke test: if this project type-checks against the
locally-built packages and runs end-to-end against a Cloudflare account, the
public release is good.

## What it exercises

| Capability                     | Wired through                        | Where it shows up                 |
| ------------------------------ | ------------------------------------ | --------------------------------- |
| `defineSchema` / `defineTable` | `@lunora/server`                     | `lunora/schema.ts`                |
| `.shardBy()` routing           | `@lunora/runtime` + `@lunora/do`     | `messages` table → per-channel DO |
| `.global()` (D1)               | `@lunora/d1`                         | `channels` + `users` tables       |
| RPC + WebSocket subscriptions  | `@lunora/runtime` + `@lunora/client` | `Chat.tsx`                        |
| Email/password auth            | `@lunora/auth`                       | `Login.tsx`, `/auth/*` routes     |
| R2 signed URLs                 | `@lunora/storage`                    | `avatars.ts`                      |
| Cron + deferred jobs           | `@lunora/scheduler`                  | `cleanup.ts`                      |
| Vite codegen + HMR             | `@lunora/vite`                       | `vite.config.ts`                  |

## Layout

```text
apps/playground/
├── lunora/
│   ├── schema.ts            # tables + sharding modifiers
│   ├── channels.ts          # global D1 table reads/writes
│   ├── messages.ts          # shard-local query + mutation
│   ├── avatars.ts           # R2 signed URL upload/download
│   └── cleanup.ts           # daily cron mutation
├── src/
│   ├── server/
│   │   ├── index.ts         # Worker entry, auth wiring
│   │   ├── ShardDO.ts       # concrete ShardDO subclass
│   │   └── SchedulerDO.ts   # concrete SchedulerDO subclass
│   └── client/
│       ├── main.tsx         # LunoraProvider mount
│       ├── App.tsx          # login or chat
│       ├── Chat.tsx         # channel list + messages
│       └── Login.tsx        # email/password form
├── vite.config.ts
├── wrangler.jsonc
└── index.html
```

## Local dev

```bash
pnpm install
cp apps/playground/.dev.vars.example apps/playground/.dev.vars   # then fill in the secrets
pnpm --filter @lunora/playground dev
```

The worker reads its secrets from `.dev.vars` (gitignored, auto-loaded by
`@cloudflare/vite-plugin`). Without it the worker throws `AUTH_SECRET is required`
on boot. Generate strong values with `openssl rand -hex 32`; see
[`.dev.vars.example`](./.dev.vars.example) for the full list (`AUTH_SECRET`,
`AUTH_URL`, `STORAGE_SECRET`, `LUNORA_ADMIN_TOKEN`).

`vite dev` provides a **local** D1 by default, so no Cloudflare account is needed
to iterate locally — the `database_id` placeholder in `wrangler.jsonc` only
matters for `deploy` (see below).

This spins up Vite + Wrangler. Codegen runs on schema edits, deltas land via
WebSocket within ~10 ms locally.

## Deploy

1. Create the D1 database:

    ```bash
    pnpm dlx wrangler d1 create lunora-playground
    ```

    Paste the returned `database_id` into `wrangler.jsonc`.

2. Create the R2 bucket:

    ```bash
    pnpm dlx wrangler r2 bucket create lunora-playground-files
    ```

3. Set secrets:

    ```bash
    pnpm dlx wrangler secret put AUTH_SECRET
    pnpm dlx wrangler secret put STORAGE_SECRET
    ```

4. Deploy:

    ```bash
    pnpm --filter @lunora/playground deploy
    ```

## Deferred for v0.2

- Real auth route handler wiring (the `Login.tsx` form posts to a stub).
- Generated `api.*` references — the client uses `anyApi` until codegen
  produces typed references for this project.
