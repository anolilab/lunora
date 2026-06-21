---
name: lunora-setup-hyperdrive-global
description: Use PlanetScale (Postgres/MySQL via Cloudflare Hyperdrive) as a first-class, REACTIVE `.global()` storage backend for a Lunora app — and migrate an existing D1 `.global()` dataset to it. Use for `@lunora/hyperdrive/global`, `.global({ backend: "hyperdrive" })`, `createHyperdriveGlobalCtxDb`, the app-builder `.hyperdriveGlobal()` declaration, the `HYPERDRIVE` binding pointing at PlanetScale, and `lunora migrate d1-to-hyperdrive`. NOT the same as `@lunora/hyperdrive` (which is an action-only, non-reactive `ctx.sql`).
---

# Lunora Setup: Hyperdrive Global Backend (Postgres/MySQL)

Store Lunora `.global()` tables in a **Postgres or MySQL database reached
through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)**
— **PlanetScale**, Neon, RDS, or any Hyperdrive-reachable database — instead of
D1, as a **drop-in, fully reactive** backend. (PlanetScale on Cloudflare is the
headline use case; nothing here is PlanetScale-specific.)

> **`@lunora/hyperdrive/global` vs. `@lunora/hyperdrive` (`ctx.sql`).** The
> `ctx.sql` surface is an action-only, **non-reactive** escape hatch for
> integrating a legacy database. `@lunora/hyperdrive/global` is different: Lunora
> **owns** the schema (column-per-field, like D1) and routes every write through
> its own store core, so live queries stay reactive — the writer is injected as
> `globalDb` and the shard DO's broadcast hook re-runs subscriptions exactly as
> with D1.

## When to Use

- You want `.global()` (cross-tenant) tables to live in PlanetScale rather than
  D1 — e.g. for larger datasets, existing SQL tooling, or unified Cloudflare
  billing.
- You're migrating an existing D1 `.global()` dataset to PlanetScale.

## When Not to Use

- You only need to read/write a **legacy** external DB from an action — use
  `@lunora/hyperdrive` (`ctx.sql`) instead; it's lighter and action-scoped.
- Your global data is small and D1 is fine — bare `.global()` (D1) needs no
  extra binding or driver.

## How it works

PlanetScale reuses Lunora's dialect-parameterized store core (the same one D1
uses): a `SqlDialect` (Postgres or MySQL) shapes the SQL, and a Hyperdrive-backed
`SqlExec` runs it from inside the Durable Object that hosts the global writer.
Values are stored SQLite-shaped (boolean → 1/0, JSON → text/json, bigint →
decimal), so the value codec is shared with D1.

## Step 1: Install the package + a driver

```bash
pnpm add @lunora/hyperdrive/global
# choose the driver matching your engine (optional peer deps — none is bundled):
pnpm add postgres        # PlanetScale Postgres → fromPostgresJs
# or
pnpm add mysql2          # PlanetScale MySQL    → mysql2/promise
```

## Step 2: Create the Hyperdrive binding pointing at PlanetScale

Create a PlanetScale database from the Cloudflare dashboard (unified billing),
then a Hyperdrive config over its connection string:

```bash
wrangler hyperdrive create my-db --connection-string="postgres://user:pass@host/db" # gitleaks:allow -- placeholder
```

Add the binding to `wrangler.jsonc` (use `localConnectionString` for `lunora dev`):

```jsonc
{
    "hyperdrive": [
        { "binding": "HYPERDRIVE", "id": "<id from the command>", "localConnectionString": "postgres://user:pass@localhost:5432/db" }, // gitleaks:allow -- placeholder
    ],
}
```

> **Read-your-writes:** point the Hyperdrive config at the **primary** (or pin
> writes to it) so a write then immediate read isn't served by a stale replica.

## Step 3: Mark tables `.global({ backend: "hyperdrive" })`

```ts
// lunora/schema.ts
import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    settings: defineTable({ key: v.string(), value: v.string() }).global({ backend: "hyperdrive" }),
});
```

A bare `.global()` stays on D1. **One backend per app** — mixing D1- and
PlanetScale-backed global tables in the same app isn't supported yet (codegen
errors clearly).

## Step 4: Wire `.hyperdriveGlobal()` in the app composition

Codegen emits a `.hyperdriveGlobal()` builder method. Supply the engine and an `exec`
built from the Hyperdrive binding (cache the driver on the DO instance; rebuild
lazily after hibernation):

```ts
import { buildPgExec } from "@lunora/hyperdrive/global";
import { fromPostgresJs } from "@lunora/hyperdrive";
import postgres from "postgres";

export default defineApp<Env>()
    .shard((env) => env.SHARD)
    .hyperdriveGlobal({
        engine: "postgres",
        exec: (env) => buildPgExec(fromPostgresJs(postgres(env.HYPERDRIVE.connectionString))),
    });
```

For MySQL, create the pool with the **`FOUND_ROWS`** flag (the optimistic-concurrency
guard needs matched-row counts, or idempotent writes raise spurious conflicts):

```ts
import { buildMysqlExec } from "@lunora/hyperdrive/global";
import mysql from "mysql2/promise";

.hyperdriveGlobal({
    engine: "mysql",
    exec: (env) => buildMysqlExec(mysql.createPool({ uri: env.HYPERDRIVE.connectionString, flags: ["FOUND_ROWS"] })),
});
```

## Step 5: Regenerate + run

```bash
lunora codegen   # wires config.hyperdriveGlobal and the .hyperdriveGlobal() method
lunora dev
```

Tables auto-provision on first use (the runtime runs the PlanetScale DDL through
the dialect — no manual migration needed), and subscriptions are reactive.

## Migrating an existing D1 dataset → PlanetScale

Blue-green: deploy the new PlanetScale-backed worker alongside the old D1 one,
then copy the `.global()` data:

```bash
lunora migrate d1-to-hyperdrive \
  --from-url https://old-d1.example.com   --from-token "$D1_ADMIN_TOKEN" \
  --to-url   https://new-ps.example.com   --to-token   "$PS_ADMIN_TOKEN" \
  --tables settings,orders                # omit to move every global table
  # --out dump.ndjson                      # keep the intermediate dump to inspect
```

It streams the source's global rows to NDJSON, imports them into the target
(whose `.global({ backend: "hyperdrive" })` tables route the writes to
PlanetScale), and verifies the row counts match. Rows whose `_id` already exists
are reported as conflicts, not duplicated.

> **Direct external writes** to PlanetScale (bypassing Lunora) are invisible to
> live queries — same as D1. Let Lunora own the writes.

## Common Pitfalls

1. **Mixing backends.** One global backend per app (codegen errors on a mix).
2. **Missing driver.** `postgres`/`mysql2` are optional peer deps — install the
   one matching your engine.
3. **Stale-replica reads.** Point Hyperdrive at the primary for read-your-writes.
4. **Expecting external writes to be reactive.** They aren't — route writes
   through Lunora (`ctx.db`).

## Checklist

- [ ] `@lunora/hyperdrive/global` + the engine's driver installed.
- [ ] Hyperdrive binding (`HYPERDRIVE`) created over the PlanetScale connection
      string, with a `localConnectionString` for dev.
- [ ] Target tables marked `.global({ backend: "hyperdrive" })` (one backend per app).
- [ ] `.hyperdriveGlobal({ engine, exec })` wired in the app composition.
- [ ] `lunora codegen` run; `lunora dev` serves the tables reactively.
- [ ] (Migrating) `lunora migrate d1-to-hyperdrive` run; row counts verified.
