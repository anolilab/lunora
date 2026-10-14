# hyperdrive

Bring-your-own Postgres or MySQL to Lunora actions via Cloudflare Hyperdrive. Query external databases from actions using `ctx.sql` — with adapters for `postgres.js` (default), `node-postgres`, and `mysql2`.

Built on [`@lunora/hyperdrive`](../../packages/hyperdrive) — the driver-agnostic `ctx.sql` adapter over Cloudflare Hyperdrive.

## Install

```bash
lunora registry add hyperdrive
```

This:

1. Adds `@lunora/hyperdrive`, `@lunora/server`, and `postgres` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/hyperdrive/index.ts` (the `queryUsers` **internal** action) into your project — this is **yours** to edit.
3. Adds a `hyperdrive` binding entry to `wrangler.jsonc` for the **`HYPERDRIVE`** binding.

Then regenerate types:

```bash
lunora codegen
```

`queryUsers` is an `internalAction`, so it surfaces in the generated **`internal`** namespace as `internal.hyperdrive.queryUsers` — reachable from your own server handlers, never from a client. See [Why there is no `runQuery`](#why-there-is-no-runquery).

## Prerequisites

1. **Create a Hyperdrive database** in the Cloudflare dashboard: **Workers & Pages → Hyperdrive → Create**. Point it at your Postgres or MySQL instance.
2. The **`HYPERDRIVE` binding** is added to `wrangler.jsonc` by this item, with a placeholder `id`. Replace `<replace-with-hyperdrive-create-id>` with the id the dashboard (or `wrangler hyperdrive create`) hands back — wrangler requires both `binding` and `id` on a hyperdrive entry and refuses to load a config that is missing one, so the placeholder fails the whole Worker's config validation until you fill it in. If you use a different binding name, update both `wrangler.jsonc` and the source file.

## How it works

The source file uses the `fromPostgresJs` adapter (for [`postgres.js`](https://github.com/porsager/postgres) — the `postgres` npm package). Swap to `fromNodePg` or `fromMysql2` for other drivers:

```ts
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import postgres from "postgres";

const { connectionString } = createHyperdrive(env.HYPERDRIVE);
const sql = fromPostgresJs(postgres(connectionString));
const rows = await sql.query("select id, name from users where email = $1", [email]);
```

### The `SqlClient` surface

Every adapter returns a `SqlClient` with exactly one method — `query(text, params)`. It is **not** a tagged template, and it has no `.unsafe()`: those belong to the raw `postgres.js` client, not to the adapter that wraps it.

```ts
const rows = await sql.query(
    `select id, name, email
     from users
     where org_id = $1 and status = 'active'
     order by name`,
    [orgId],
);
```

`text` is executed verbatim — the package never rewrites or escapes it. Put every **value** in `params` behind a positional placeholder (`$1`, `$2` for Postgres; `?` for MySQL). Identifiers (table and column names) cannot be parameterised at all — allowlist them against a fixed set rather than interpolating them.

### Why there is no `runQuery`

This item deliberately ships no "run arbitrary SQL" helper. An endpoint that executes a caller-supplied statement against your production database is a remote SQL console — `DROP TABLE`, a full-table `SELECT`, `pg_read_file()`. Authentication does not contain it: the statement itself is the payload, so any handler that forwards a client-supplied string into it reopens the hole. Write purpose-specific, parameterised statements instead; `queryUsers` is the shape to copy.

### Why `queryUsers` is internal

Lunora `action`s are public RPC. A client-callable "look a user up by email" is an identity oracle: it confirms whether an address has an account and returns its id and name to anyone who asks. So `queryUsers` is an `internalAction` — call it from your own handlers with `ctx.runAction(internal.hyperdrive.queryUsers, { email })` **after** you have authenticated the caller and decided what they may read. If you need a client-callable read, write a purpose-specific `action` that takes safe business inputs, checks `ctx.auth`/RBAC, scopes the statement to the caller server-side, and rate-limits it with [`@lunora/ratelimit`](../ratelimit).

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
