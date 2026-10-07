---
name: lunora-setup-hyperdrive
description: Connects an existing, externally owned Postgres/MySQL database to a Lunora app through Cloudflare Hyperdrive. Lunora does not own its schema. Covers `@lunora/hyperdrive`, the action-only, non-reactive `ctx.sql` client (`createHyperdrive` + `fromPostgresJs`/`fromNodePg`/`fromMysql2`, wired with the app builder's `.hyperdrive()`), the `HYPERDRIVE` binding and `wrangler hyperdrive create`, and making external rows live through a projection or a `.source()` ingest table. Use when the user wants to "query our existing Postgres", "read the legacy DB from an action", "connect Neon/RDS/Supabase", or sync external rows into Lunora, or sees `ctx.sql` / `hyperdrive_outside_action` errors. For storing Lunora's own `.global()` tables in Postgres/MySQL with reactive live queries, use `lunora-setup-hyperdrive-global` instead.
---

# Lunora Setup Hyperdrive

`@lunora/hyperdrive` exposes a Cloudflare Hyperdrive binding as a
driver-agnostic `ctx.sql` client that is available only inside an `action`. It integrates
a database Lunora doesn't own. Don't use it to replace `defineSchema`, because you'd lose
realtime, OCC, optimistic updates, the offline queue and the advisors.

> **`ctx.sql` is not reactive.** Lunora cannot see this database, so subscriptions
> do not re-run when its rows change, including rows you write through `ctx.sql`.
> Queries are non-deterministic, so `ctx.sql` exists only on `ActionCtx`.
> The `hyperdrive_outside_action` advisor lint flags any use in a
> `query`/`mutation`. To make the data live, see Step 5. If you instead want Lunora-owned tables
> stored in Postgres/MySQL and fully reactive, use `lunora-setup-hyperdrive-global`.

## Step 1: Install the package + one driver

```bash
pnpm add @lunora/hyperdrive
pnpm add postgres   # → fromPostgresJs   ($1, $2 placeholders)
# or: pnpm add pg      → fromNodePg       ($1, $2)
# or: pnpm add mysql2  → fromMysql2       (?)
```

The drivers are optional peer dependencies, so none ships with the package.
The package never rewrites SQL, so use your driver's native placeholders.

## Step 2: Create the binding

```bash
wrangler hyperdrive create my-db --connection-string="postgres://user:pass@host:5432/db" # gitleaks:allow -- placeholder, not a real secret
```

Add the printed `id` to `wrangler.jsonc`. `localConnectionString` lets `lunora dev`
connect directly:

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

Lunora validates the entry but never writes the `id` itself, because only
`wrangler hyperdrive create` can mint it. Validation fails without a `binding`
and warns when `id` is empty.

## Step 3: Regenerate types

```bash
lunora codegen
```

When `ctx.sql` is used, codegen adds `readonly sql: SqlClient` to `ActionCtx` only. It also
emits a `.hyperdrive()` method on the generated app builder.

## Step 4: Wire the client on the app builder

`ctx.sql` is `readonly`, so assigning it in a handler is a `TS2540` error.
Codegen can't build the client because it depends on your driver, so supply a
thunk instead. It runs once per shard construction, not per request:

```ts title="src/server.ts"
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

Then query from any action:

```ts
import { LunoraError } from "lunorash/server";

import { action, v } from "#lunora/_generated/server.js";

export const listLegacyOrders = action.input({ orgId: v.string() }).action(async ({ ctx, args: { orgId } }) => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    // `orgId` comes from the client: the join scopes it to orgs the caller belongs to.
    return ctx.sql.query<{ id: string; total: number }>(
        "select o.id, o.total from orders o join org_members m on m.org_id = o.org where o.org = $1 and m.user_id = $2",
        [orgId, ctx.auth.userId],
    );
});
```

**Verify:** call the action from the studio's function runner and check that it returns rows.

## Step 5 (optional): Make external data reactive

Pick one approach:

**A. Projection from an action.** This works when your app is the writer. Write the row into a
`defineSchema` table through a mutation. That write is tracked:

```ts
import { internal } from "#lunora/_generated/internal.js";

const [row] = await ctx.sql.query<{ id: string; total: number }>("select id, total from orders where id = $1", [id]);

// Re-runs live queries over `orders`. ctx.run* takes a generated reference, not a "file:fn" string.
await ctx.runMutation(internal.orders.upsert, { id: row.id, total: row.total });
```

**B. A `.source()` table.** This works when other systems also write the database. Lunora polls
the external query on the shard's alarm, diffs the result, materializes it into the
DO's SQLite and notifies subscribers, so you don't write an action or a cron:

```ts
// lunora/schema.ts
messages: defineTable({ body: v.string(), channelId: v.string() })
    .shardBy("channelId")
    .source({
        binding: "HYPERDRIVE",
        query: 'select id, body, channel_id as "channelId" from messages where channel_id = $1',
        tenantBy: (shardKey) => [shardKey], // required under .shardBy(): the tenant boundary
    }),
```

```ts
// worker entry: one client per binding name
.sourceClient((env, binding) => fromPostgresJs(postgres((env[binding] as { connectionString: string }).connectionString)))
```

How `.source()` behaves:

- Freshness depends on the poll interval: every alarm tick by default,
  `refresh: { everyMs }` to throttle it, or `"manual"`.
- The table is read-only from Lunora: rows come only from the ingest loop.
- The default `mode: "full-pull"` re-reads the whole slice on every tick, which
  works up to about 10k rows. For larger slices, use `mode: "incremental"` with a
  `cursor`, plus either `reconcileEveryMs` or `softDeleteColumn` so deletes are
  still detected.
- A source table can't also be `.global()`.

## Common Pitfalls

1. **`ctx.sql` in a query/mutation.** It's action-only. Move the SQL into an action.
2. **Expecting `ctx.sql` writes to update subscriptions.** They don't. Use Step 5.
3. **Placeholder or empty `id`.** The binding can't connect. Run
   `wrangler hyperdrive create` and paste the id.
4. **Wrong placeholders.** Use `$1` for `postgres`/`pg` and `?` for `mysql2`.
5. **Unscoped `.source()` under `.shardBy()`.** Without `tenantBy`, every tenant's
   rows are copied into each shard. `defineSchema` throws, and the
   `external_source_unscoped` lint fails the build.
