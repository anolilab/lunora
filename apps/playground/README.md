# @cirrus/playground

A real-time chat app that exercises every part of Cirrus v0.1 — sharded
Durable Objects, D1, R2 signed URLs, email/password auth, and the scheduler.

It doubles as the v0.1 smoke test: if this project type-checks against the
locally-built packages and runs end-to-end against a Cloudflare account, the
public release is good.

## What it exercises

| Capability                     | Wired through                        | Where it shows up                 |
| ------------------------------ | ------------------------------------ | --------------------------------- |
| `defineSchema` / `defineTable` | `@cirrus/server`                     | `cirrus/schema.ts`                |
| `.shardBy()` routing           | `@cirrus/runtime` + `@cirrus/do`     | `messages` table → per-channel DO |
| `.global()` (D1)               | `@cirrus/d1`                         | `channels` + `users` tables       |
| RPC + WebSocket subscriptions  | `@cirrus/runtime` + `@cirrus/client` | `Chat.tsx`                        |
| Email/password auth            | `@cirrus/auth`                       | `Login.tsx`, `/auth/*` routes     |
| R2 signed URLs                 | `@cirrus/storage`                    | `avatars.ts`                      |
| Cron + deferred jobs           | `@cirrus/scheduler`                  | `cleanup.ts`                      |
| Vite codegen + HMR             | `@cirrus/vite`                       | `vite.config.ts`                  |

## Layout

```text
apps/playground/
├── cirrus/
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
│       ├── main.tsx         # CirrusProvider mount
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
pnpm --filter @cirrus/playground dev
```

This spins up Vite + Wrangler. Codegen runs on schema edits, deltas land via
WebSocket within ~10 ms locally.

## Deploy

1. Create the D1 database:

    ```bash
    pnpm dlx wrangler d1 create cirrus-playground
    ```

    Paste the returned `database_id` into `wrangler.jsonc`.

2. Create the R2 bucket:

    ```bash
    pnpm dlx wrangler r2 bucket create cirrus-playground-files
    ```

3. Set secrets:

    ```bash
    pnpm dlx wrangler secret put AUTH_SECRET
    pnpm dlx wrangler secret put STORAGE_SECRET
    ```

4. Deploy:

    ```bash
    pnpm --filter @cirrus/playground deploy
    ```

## Deferred for v0.2

- Real auth route handler wiring (the `Login.tsx` form posts to a stub).
- Actual D1 read/write inside `ShardDO.handleRpc` (we currently dispatch to
  a stub `ctx.db`).
- Generated `api.*` references — the client uses `anyApi` until codegen
  produces typed references for this project.
