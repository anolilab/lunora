<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="r2sql" />

</a>

<h3 align="center">Typed, chainable R2 SQL for Lunora: window functions, DISTINCT, set operations, and ctx.r2sql</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<br />

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![npm version][npm-version-badge]][npm-version]
[![npm downloads][npm-downloads-badge]][npm-downloads]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

Query Cloudflare [R2 SQL](https://developers.cloudflare.com/r2-sql/) — the serverless, distributed query engine over [Apache Iceberg](https://iceberg.apache.org/) tables in [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/) — from a Lunora **action** via `ctx.r2sql`, with a typed, chainable query builder.

First-class support for the [2026-06-21 release](https://developers.cloudflare.com/changelog/post/2026-06-21-window-functions-distinct-set-operations/): **window functions**, **`DISTINCT` / `DISTINCT ON`**, **`QUALIFY`**, and **set operations** (`UNION` / `INTERSECT` / `EXCEPT`).

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

> **Action-only, non-reactive.** R2 SQL has no Workers binding — every query is an HTTPS round-trip. Like Hyperdrive's `ctx.sql`, it is non-deterministic external I/O: it is typed onto `ActionCtx` only, and its reads are **not** tracked by Lunora live queries. The `r2sql_outside_action` advisor lint flags any use in a `query`/`mutation`.

## Install

```sh
pnpm add @lunora/r2sql
```

## Setup

R2 SQL is reached over REST with a Cloudflare API token scoped to **R2 SQL (read)**, **R2 Data Catalog**, and **R2 storage**. Provide the token + account id + bucket from your environment — the token is a secret, never a binding:

```ts
import { createR2Sql } from "@lunora/r2sql";

const r2sql = createR2Sql({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.R2_SQL_TOKEN, // secret
    bucket: "analytics", // the R2 bucket whose Data Catalog you query
});
```

Inside Lunora, codegen wires `ctx.r2sql` for you when an action imports `@lunora/r2sql` or reads `ctx.r2sql` — set `R2_SQL_TOKEN` (and optionally `R2_SQL_ACCOUNT_ID` / `R2_SQL_BUCKET`) in `.dev.vars`, or pass an `r2sql` config thunk to `createShardDO()`.

## Query builder

```ts
import { fn, desc, sql } from "@lunora/r2sql";

export const topCustomersPerRegion = action({
    args: {},
    handler: async (ctx) => {
        // Window function + QUALIFY: top 3 customers by amount in each region.
        const { rows } = await ctx.r2sql
            .from<{ customer_id: string; region: string; total_amount: number }>("sales.orders")
            .select("customer_id", "region", "total_amount")
            .qualify(
                fn
                    .rowNumber()
                    .over({ partitionBy: "region", orderBy: desc("total_amount") })
                    .lte(3),
            )
            .run();

        return rows;
    },
});
```

### DISTINCT / DISTINCT ON

```ts
// Unique (region, department) combinations.
ctx.r2sql.from("sales.orders").select("region", "department").distinct();

// First row per region by amount (DISTINCT ON honours ORDER BY).
ctx.r2sql.from("sales.orders").distinctOn("region").select("region", "customer_id", "total_amount").orderBy("region", desc("total_amount"));
```

### Window functions

```ts
ctx.r2sql.from("sales.orders").select(
    "customer_id",
    fn
        .rowNumber()
        .over({ partitionBy: "region", orderBy: desc("total_amount") })
        .as("rank_in_region"),
    fn
        .lag("total_amount")
        .over({ partitionBy: "region", orderBy: desc("total_amount") })
        .as("prev_amount"),
    fn.sum("total_amount").over({ orderBy: "total_amount", frame: "ROWS BETWEEN 2 PRECEDING AND CURRENT ROW" }).as("running_total"),
);
```

### Set operations

```ts
const blocked = ctx.r2sql
    .from("security.firewall_events")
    .select("zone_id")
    .where(sql`action = ${"block"}`);
const enterprise = ctx.r2sql
    .from("security.zones")
    .select("zone_id")
    .where(sql`plan = ${"enterprise"}`);

// Enterprise zones with no firewall events.
const { rows } = await enterprise.except(blocked).run();
```

### Safe values with the `sql` tag

R2 SQL has no parameter binding, so values are inlined. The `sql` tag escapes every interpolation, so user input can't break out of its literal:

```ts
const region = userInput; // untrusted
ctx.r2sql
    .from("sales.orders")
    .where(sql`region = ${region}`)
    .limit(100);
```

## Raw escape hatch + schema discovery

```ts
// Raw SQL, typed rows:
const { rows } = await ctx.r2sql.query<{ total: number }>(sql`SELECT COUNT(*) AS total FROM sales.orders`);

// Inspect the plan without running:
await ctx.r2sql.explain(sql`SELECT * FROM sales.orders LIMIT 10`, { format: "json" });

// Iceberg schema discovery (the surface Studio uses):
await ctx.r2sql.showDatabases();
await ctx.r2sql.showTables("sales");
await ctx.r2sql.describe("sales.orders");
```

## API

- `createR2Sql({ accountId, apiToken, bucket, endpoint?, fetch? })` → `R2SqlClient`
- `R2SqlClient`: `from<Row>(table)`, `query<Row>(sql)`, `explain(sql, opts?)`, `showDatabases()`, `showTables(ns)`, `describe(table)`
- Builder: `.select()`, `.distinct()`, `.distinctOn()`, `.where()`, `.innerJoin()/.leftJoin()/.rightJoin()/.fullJoin()/.crossJoin()`, `.groupBy()`, `.having()`, `.qualify()`, `.orderBy()`, `.limit()`, `.union()/.unionAll()/.intersect()/.except()`, `.returns<R>()`, `.toSQL()`, `.run()`
- Window: `fn.rowNumber()/rank()/denseRank()/percentRank()/cumeDist()/ntile()/lag()/lead()/firstValue()/lastValue()/nthValue()/sum()/avg()/count()/min()/max()` → `.over({ partitionBy, orderBy, frame })` → `.as(alias)` | `.lte()/.lt()/.gte()/.gt()/.eq()/.between()`
- Values: `sql` (tagged template), `lit()`, `raw()`, `asc()`, `desc()`

[typescript-badge]: https://img.shields.io/badge/TypeScript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/ "TypeScript"
[license-badge]: https://img.shields.io/npm/l/@lunora/r2sql?color=blueviolet&style=for-the-badge
[license]: LICENSE.md "license"
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/r2sql/latest.svg?style=for-the-badge&logo=npm
[npm-version]: https://www.npmjs.com/package/@lunora/r2sql/v/latest "npm version"
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/r2sql?logo=npm&style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/r2sql "npm downloads"
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/main/.github/CONTRIBUTING.md "PRs welcome"
