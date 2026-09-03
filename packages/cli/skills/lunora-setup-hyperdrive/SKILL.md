---
name: lunora-setup-hyperdrive
description: Connects an existing Postgres/MySQL database to a Lunora app from an action via Cloudflare Hyperdrive. Use for `@lunora/hyperdrive`, `ctx.sql`, `createHyperdrive` + `fromPostgresJs`/`fromNodePg`/`fromMysql2`, the `HYPERDRIVE` binding, `wrangler hyperdrive create`, and the action-only / non-reactive guardrails (live queries don't track external writes).
---

# Lunora Setup Hyperdrive

Wire an **existing** Postgres/MySQL database into a Lunora app using
`@lunora/hyperdrive`, which surfaces a [Cloudflare
Hyperdrive](https://developers.cloudflare.com/hyperdrive/) binding's connection
string and a driver-agnostic `ctx.sql` client — usable **only inside an
`action`**.

> **Integrate, don't replace.** Hyperdrive talks to a database Lunora has no
> visibility into. Queries through `ctx.sql` are **non-deterministic** (forbidden
> in `query`/`mutation`, enforced by the `hyperdrive_outside_action` advisor
> lint) and external writes are **invisible to Lunora live queries** —
> subscriptions will NOT re-run when external rows change. Use it to read/write a
> legacy DB from an action; if you want that data reactive, write a projection
> into a `defineSchema` DO/D1 table.

## When to Use

- Reading/writing an existing Postgres or MySQL database from a Lunora action.
- Incrementally migrating off a legacy DB while standing up Lunora alongside it.
- Backfilling/syncing external rows into reactive Lunora tables (projection).

## When Not to Use

- You want the external data to be **reactive** out of the box — it can't be;
  Hyperdrive writes don't hit the change-feed. Project into a `defineSchema`
  table instead.
- You're reaching for `ctx.sql` inside a `query` or `mutation` — forbidden by
  design (the advisor lint flags it). Move the access into an `action`.
- The app has no Lunora backend yet — use `lunora-quickstart` first.
- You'd be replacing `defineSchema` entirely — then you lose realtime, OCC,
  optimistic updates, the offline queue, and the advisors. Use Lunora's own data
  layer for app state.

## Workflow

1. Install `@lunora/hyperdrive` and one SQL driver.
2. Create the Hyperdrive config (`wrangler hyperdrive create`) and add the
   `HYPERDRIVE` binding to `wrangler.jsonc`.
3. Regenerate types with `lunora codegen` so `ctx.sql` appears on `ActionCtx`.
4. Read/write the external DB from an action via `ctx.sql`.
5. (Optional) Project external rows into a `defineSchema` table to make them
   reactive.

## Step 1: Install the package + a driver

```bash
pnpm add @lunora/hyperdrive
# choose ONE driver (optional peer deps — none is bundled):
pnpm add postgres        # postgres.js  → fromPostgresJs ($1, $2 placeholders)
# or
pnpm add pg              # node-postgres → fromNodePg     ($1, $2 placeholders)
# or
pnpm add mysql2          # mysql2        → fromMysql2      (?  placeholders)
```

## Step 2: Create the binding

```bash
wrangler hyperdrive create my-db --connection-string="postgres://user:pass@host:5432/db" # gitleaks:allow -- placeholder, not a real secret
```

This prints an `id`. Add the binding to `wrangler.jsonc`, using
`localConnectionString` so `lunora dev` connects to your DB directly (no edge
proxy locally):

```jsonc
{
    "hyperdrive": [
        {
            "binding": "HYPERDRIVE",
            "id": "<the id from the command above>",
            "localConnectionString": "postgres://user:pass@localhost:5432/db", // gitleaks:allow -- placeholder, not a real secret
        },
    ],
}
```

Lunora validates this binding (errors if `binding` is missing; warns if `id` is
empty/placeholder — it can't connect), but it does **not** auto-write the `id`:
that's a remote resource only `wrangler hyperdrive create` can mint. Importing
`@lunora/hyperdrive` surfaces a hint reminding you to add it.

## Step 3: Regenerate types

```bash
lunora codegen
```

When codegen sees `ctx.sql` used, it adds `readonly sql: SqlClient` to
**`ActionCtx` only** — never `QueryCtx`/`MutationCtx` — with a JSDoc restating
the determinism/realtime caveat, and emits a `.hyperdrive()` method on the
generated app builder for you to supply the client (step 4).

## Step 4: Wire the client once, on the app builder

`ctx.sql` is `readonly` — assigning to it inside a handler is a `TS2540`.
Codegen cannot build the client for you (turning a connection string into a
`SqlClient` needs the driver you chose), so it emits a config thunk you fill in
at the app level. It is called once per shard construction, not per request:

```ts title="src/server/index.ts"
import type { HyperdriveLike } from "@lunora/hyperdrive";
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import postgres from "postgres";

import { defineApp } from "../lunora/_generated/app.js";

const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .hyperdrive((env) => fromPostgresJs(postgres(createHyperdrive(env.HYPERDRIVE as HyperdriveLike).connectionString)))
    .build();

export const ShardDO = app.ShardDO;
```

Then read it from any action:

```ts
import { action, v } from "@/lunora/_generated/server";

export const listLegacyOrders = action
    .input({ orgId: v.string() })
    .action(async ({ ctx, args: { orgId } }) => ctx.sql.query<{ id: string; total: number }>("select id, total from orders where org = $1", [orgId]));
```

The package never rewrites SQL — use your driver's native placeholders (`$1` for
Postgres, `?` for MySQL).

## Step 5 (optional): Make it reactive via a projection

External writes don't hit the change-feed, so a subscription won't re-fire on a
Postgres change. To make external data reactive, write a projection into a
`defineSchema` table from the same action — that write _is_ tracked:

```ts
import { api } from "@/lunora/_generated/api";

const [row] = await ctx.sql.query<{ id: string; total: number }>("select id, total from orders where id = $1", [id]);

// This write re-runs live queries reading `orders`. Pass the generated
// reference — `ctx.run*` takes a reference, not a "file:fn" string.
await ctx.runMutation(api.orders.upsert, { id: row.id, total: row.total });
```

## Common Pitfalls

1. **`ctx.sql` in a query/mutation.** It's action-only by design; the
   `hyperdrive_outside_action` advisor lint flags it. Move the SQL into an
   action.
2. **Expecting external writes to be reactive.** They aren't — Lunora can't see
   them. Project into a `defineSchema` table if you need reactivity.
3. **Placeholder / empty `id`.** A Hyperdrive binding with no real `id` can't
   connect (Lunora warns). Run `wrangler hyperdrive create` and paste the id.
4. **Bundling a driver as a hard dependency.** Drivers are optional peer deps —
   install the one you use; don't assume one ships with the package.
5. **Wrong placeholder syntax.** `$1, $2` for Postgres drivers, `?` for mysql2.
   The package does not rewrite SQL.

## Checklist

- [ ] `@lunora/hyperdrive` + one driver (`postgres`/`pg`/`mysql2`) installed.
- [ ] `wrangler hyperdrive create` run; `HYPERDRIVE` binding added to
      `wrangler.jsonc` with a real `id` and a `localConnectionString` for dev.
- [ ] `lunora codegen` run so `ctx.sql` is typed on `ActionCtx`.
- [ ] All `ctx.sql` access lives in actions (advisor clean — no
      `hyperdrive_outside_action`).
- [ ] If reactivity is needed, external rows are projected into a `defineSchema`
      table.
