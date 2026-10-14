---
name: lunora-setup-hyperdrive-global
description: Stores a Lunora app's own `.global()` tables in Postgres or MySQL (PlanetScale, Neon, RDS, or any Hyperdrive-reachable database) through Cloudflare Hyperdrive instead of D1. Lunora owns the schema, and live queries stay fully reactive. Also migrates an existing D1 `.global()` dataset with `lunora migrate d1-to-hyperdrive`. Covers `.global({ backend: "hyperdrive" })`, `@lunora/hyperdrive/global` (`buildPgExec` / `buildMysqlExec`, `createHyperdriveGlobalCtxDb`), the app builder's `.hyperdriveGlobal({ engine, exec })`, and the `HYPERDRIVE` binding. Use when the user wants to "move global tables to PlanetScale/Postgres", "use Postgres instead of D1", or "migrate off D1", or edits `.global({ backend: "hyperdrive" })`. For querying an existing, externally owned database from an action (non-reactive `ctx.sql`), use `lunora-setup-hyperdrive` instead.
---

# Lunora Setup: Hyperdrive Global Backend (Postgres/MySQL)

Store `.global()` (cross-tenant) tables in a Postgres or MySQL database reached
through Cloudflare Hyperdrive instead of D1. PlanetScale on Cloudflare is the
typical case, but nothing here is PlanetScale-specific.

> **This is not `ctx.sql`.** `@lunora/hyperdrive`'s `ctx.sql`
> (`lunora-setup-hyperdrive`) is an action-only, non-reactive client for a
> database Lunora doesn't own. `.global({ backend: "hyperdrive" })` is the opposite:
> Lunora owns the tables (one column per field, like D1), and every write goes
> through Lunora's store core. Subscriptions re-run exactly as they do with D1.
> The live-query guarantee covers only writes made through Lunora (`ctx.db`).
> Rows written to the database directly are invisible to live queries.

## When Not to Use

- You only need to read or write a legacy database from an action: use
  `lunora-setup-hyperdrive`.
- Your global data is small and D1 is fine: bare `.global()` needs no extra
  binding or driver.

## How it works

The same dialect-parameterized store core that backs D1 runs here with a
Postgres or MySQL `SqlDialect`. A Hyperdrive-backed `SqlExec` executes it from
inside the Durable Object that hosts the global writer. Values are stored in the
same shapes D1 uses (boolean → 1/0, JSON → text/json, bigint → decimal).

## Step 1: Install

```bash
pnpm add @lunora/hyperdrive @lunora/sql-store
pnpm add postgres   # Postgres engine → buildPgExec(fromPostgresJs(...))
# or: pnpm add mysql2  → buildMysqlExec(mysql2/promise pool), MySQL 8.0+
```

`@lunora/hyperdrive/global` is a subpath export of `@lunora/hyperdrive`, not a
separate package. Codegen requires `@lunora/sql-store` too, because the generated
`_generated/app.ts` imports its `SqlExec` types. Install the driver that matches
your engine. Drivers are optional peer dependencies.

## Step 2: Create the Hyperdrive binding

```bash
wrangler hyperdrive create my-db --connection-string="postgres://user:pass@host/db" # gitleaks:allow -- placeholder
```

```jsonc
{
    "hyperdrive": [
        { "binding": "HYPERDRIVE", "id": "<id from the command>", "localConnectionString": "postgres://user:pass@localhost:5432/db" }, // gitleaks:allow -- placeholder
    ],
}
```

A binding is required. Without any `hyperdrive` entry, config validation errors
and `lunora dev` / `lunora deploy` won't start. You choose the name: the
validator only checks that at least one binding exists, and your `exec` selector picks it.

Point Hyperdrive at the primary (or pin writes to it) so you can read your own
writes. A replica can serve a stale read right after a write.

## Step 3: Mark tables

```ts
// lunora/schema.ts
import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    settings: defineTable({ key: v.string(), value: v.string() }).global({ backend: "hyperdrive" }),
});
```

Bare `.global()` stays on D1. An app can use only one global backend: codegen fails
if the schema mixes D1 and Hyperdrive global tables.

## Step 4: Wire `.hyperdriveGlobal()`

Codegen emits a `.hyperdriveGlobal({ engine, exec, origin? })` builder method.
`exec` builds a `SqlExec` from `env`:

```ts
import { fromPostgresJs } from "@lunora/hyperdrive";
import { buildPgExec } from "@lunora/hyperdrive/global";
import postgres from "postgres";

import { defineApp } from "../lunora/_generated/app.js";

const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .hyperdriveGlobal({
        engine: "postgres",
        exec: (env) => buildPgExec(fromPostgresJs(postgres(env.HYPERDRIVE.connectionString))),
    })
    .build();

export const ShardDO = app.ShardDO;
```

For MySQL, create the pool with the `FOUND_ROWS` flag. The optimistic-concurrency
guard needs matched-row counts. Without the flag, an idempotent write reports
zero affected rows and raises a spurious conflict. `buildMysqlExec` throws at
construction when the flag is missing. If it can't read the flag, it warns once instead.

```ts
import { buildMysqlExec } from "@lunora/hyperdrive/global";
import mysql from "mysql2/promise";

// inside the builder chain:
.hyperdriveGlobal({
    engine: "mysql",
    exec: (env) => buildMysqlExec(mysql.createPool({ uri: env.HYPERDRIVE.connectionString, flags: ["FOUND_ROWS"] })),
})
```

Outside the app builder, for example in tests or a custom host,
`createHyperdriveGlobalCtxDb({ engine, exec, ... })` builds the same reactive writer
directly.

## Step 5: Regenerate and run

```bash
lunora codegen
lunora dev
```

Tables provision automatically on first use, because the runtime runs the DDL
through the dialect. You don't write or commit SQL migrations. `CREATE TABLE IF NOT EXISTS` never
reshapes an existing table, though. When a column's validator starts accepting
null, the store reports the `ALTER` statement to run. MySQL tables created before
the `utf8mb4_0900_bin` column collation need a one-off
`ALTER TABLE … CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`.
See `lunora-migration-helper` for schema changes.

**Verify:** subscribe to a query over a hyperdrive-backed table, write through a
mutation, and confirm that the subscription updates.

Postgres deployments can also serve `ctx.vectors` from pgvector instead of a Vectorize
binding with `createPgVectorIndex` (from `@lunora/hyperdrive/global`). It supports
equality-only metadata filters.

## Migrating an existing D1 dataset

The flow is blue-green: deploy the Hyperdrive-backed worker next to the D1 one,
then copy the data:

```bash
lunora migrate d1-to-hyperdrive \
  --from-url https://old-d1.example.com --from-token "$D1_ADMIN_TOKEN" \
  --to-url   https://new-hd.example.com --to-token   "$HD_ADMIN_TOKEN" \
  --tables settings,orders   # omit to move every global table; --out dump.ndjson keeps the dump
```

The command exports the source's global rows to NDJSON, imports them into the
target, and compares row counts. It refuses to run when the source and target
resolve to the same URL, and non-localhost URLs must use https. Rows whose `_id`
already exists in the target are reported as conflicts and not duplicated.
A count mismatch is a warning: inspect it with `--out`, resolve it, and re-run.
Tokens default to `--token` / `LUNORA_ADMIN_TOKEN`.

## Common Pitfalls

1. **Installing `@lunora/hyperdrive/global` as a package name.** It's a subpath.
   Install `@lunora/hyperdrive` and `@lunora/sql-store`.
2. **Mixing D1 and Hyperdrive global tables.** Codegen rejects this.
3. **Missing `FOUND_ROWS` on MySQL.** It causes spurious OCC conflicts on idempotent writes.
4. **Stale-replica reads.** Point Hyperdrive at the primary.
5. **Writing to the database directly.** Live queries won't see those writes. Route writes
   through `ctx.db`.
