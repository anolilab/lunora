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
| Studio data + SQL surface      | `@lunora/studio`                     | `/__lunora`, `demoRecords` table  |

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

## Studio demo walkthrough

The admin UI is served alongside the app at **<http://localhost:5173/__lunora>**.
`demoRecords` is the table it is meant to be opened against — seed it first, or
the data browser has nothing to draw:

```bash
# from apps/playground — the repo has no linked `lunora` bin, the scripts call it by path
node node_modules/lunorash/dist/bin.mjs seed --table demoRecords --count 250
```

Four of its columns exist for their **declared type**, because the row editor and
the grid header read the schema rather than the value in the cell:

| Try this                                                                | Column                      | What it proves                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Edit a row — `status` and `currency` render dropdowns, not text boxes   | `v.union(v.literal…)`       | The editor reads `enumValues` off the schema, so an illegal value cannot be typed or pasted                                       |
| Paste a TSV block over a `status` column with a value outside the union | `status`                    | Paste validates against the **declared column**, and reports the cells it skipped rather than dropping them silently              |
| Toggle `archived`; clear `notes`                                        | `v.boolean()`, `v.optional` | The editor renders a checkbox from the declared kind, and offers "clear" only for the optional columns (`notes`, `attachmentKey`) |
| Look at `attachmentKey` cells                                           | `v.storage("avatars")`      | The grid resolves a signed URL and previews the object inline, from the **named** bucket                                          |
| Scan the grid header                                                    | all                         | Each header carries a one-character glyph for its validator kind; a column the schema does not describe carries none              |

### SQL console

Multi-statement scripts run as **separate gated calls** — one result tab per
statement, including any the gate refuses, so a three-statement script never
looks like a two-statement one:

```sql
SELECT status, COUNT(*) AS n FROM demoRecords GROUP BY status ORDER BY n DESC;
SELECT currency, ROUND(SUM(amount), 2) AS total FROM demoRecords GROUP BY currency;
SELECT region, AVG(priority) AS avg_priority FROM demoRecords GROUP BY region;
```

The gate is still per statement, and it is the enforcement point for the whole
console — a write is refused in its own tab while the reads beside it still run.
Two single statements worth pasting, both of which the batch scanner used to
misread as two and reject outright:

```sql
SELECT 'a;b' AS quoted_semicolon;   -- one statement: the ; is inside a literal, not a boundary
SELECT "a;b" FROM demoRecords;      -- one statement: quoted IDENTIFIER, likewise not a boundary
```

History is scoped per deployment and is **off by default**; the toggle purges
what a previous build left on disk rather than only stopping new writes.

### Dashboards

Widgets come in four kinds — `chart`, `kpi`, `table`, `text` — and a chart can be
`bar`, `line`, or `area`. The shape you pick always wins over the assistant's
inference, so the picker works with no AI binding configured:

```sql
-- chart (line): rows per day over the seeded six-month spread
SELECT DATE(createdAt / 1000, 'unixepoch') AS day, COUNT(*) AS n
FROM demoRecords GROUP BY day ORDER BY day;

-- kpi: reads the first cell of the first row
SELECT COUNT(*) AS open_records FROM demoRecords WHERE status = 'open';
```

Dashboards, history, and shortcut bindings live in the browser, so they are per
operator and do not ship with the app.

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
