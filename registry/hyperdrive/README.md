# hyperdrive

Bring-your-own Postgres or MySQL to Lunora actions via Cloudflare Hyperdrive. Query external databases from actions using `ctx.sql` — with adapters for `postgres.js` (default), `node-postgres`, and `mysql2`.

Built on [`@lunora/hyperdrive`](../../packages/hyperdrive) — the driver-agnostic `ctx.sql` adapter over Cloudflare Hyperdrive.

## Install

```bash
lunora registry add hyperdrive
```

This:

1. Adds `@lunora/hyperdrive`, `@lunora/server`, and `postgres` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/hyperdrive/index.ts` (the `queryUsers` and `runQuery` actions) into your project — this is **yours** to edit.
3. Adds a `hyperdrive` binding entry to `wrangler.jsonc` for the **`HYPERDRIVE`** binding.

Then regenerate types:

```bash
lunora codegen
```

The functions surface in the generated `api` as `hyperdrive/queryUsers` and `hyperdrive/runQuery`.

## Prerequisites

1. **Create a Hyperdrive database** in the Cloudflare dashboard: **Workers & Pages → Hyperdrive → Create**. Point it at your Postgres or MySQL instance.
2. The **`HYPERDRIVE` binding** is added to `wrangler.jsonc` by this item. If you use a different binding name, update both `wrangler.jsonc` and the source file.

## How it works

The source file uses the `fromPostgresJs` adapter (for [`postgres.js`](https://github.com/porsager/postgres) — the `postgres` npm package). Swap to `fromNodePg` or `fromMysql2` for other drivers:

```ts
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import postgres from "postgres";

const { connectionString } = createHyperdrive(env.HYPERDRIVE);
const sql = fromPostgresJs(postgres(connectionString));
const rows = await sql`select id, name from users where email = ${email}`;
```

### Tagged-template queries

The `postgres.js` client supports tagged-template literals, which are auto-parameterised and safe from injection:

```ts
const rows = await sql`
    select id, name, email
    from users
    where org_id = ${orgId} and status = 'active'
    order by name
`;
```

### Unsafe / raw queries

For dynamic query strings, use `sql.unsafe`:

```ts
const rows = await sql.unsafe("select * from users where id = $1", [userId]);
```

### Other adapters

| Adapter          | Import               | npm package |
| ---------------- | -------------------- | ----------- |
| `fromPostgresJs` | `@lunora/hyperdrive` | `postgres`  |
| `fromNodePg`     | `@lunora/hyperdrive` | `pg`        |
| `fromMysql2`     | `@lunora/hyperdrive` | `mysql2`    |

All three follow the same pattern: `createHyperdrive(env.MY_BINDING)` returns `{ connectionString }`, pass that to your driver, then wrap with the adapter.

## Action-only guardrails

Hyperdrive connects to external databases with side effects. Queries are **action-only** — they run on `ActionCtx` and are never retried automatically. This aligns with Lunora's determinism guarantees: queries and mutations are deterministic (replayed on the DO), while actions are not.

## What you own

Everything under `lunora/hyperdrive/` is copied into your repo — change the queries, switch drivers, add more actions (inserts, updates, transactions), or wire in a different database schema however you like. `@lunora/hyperdrive` provides the Hyperdrive binding reader and adapter helpers; this component is the idiomatic Lunora glue that turns it into `api.hyperdrive.*`.
