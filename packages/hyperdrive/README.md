<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="hyperdrive" />

</a>

<h3 align="center">Bring-your-own Postgres/MySQL for Lunora via Cloudflare Hyperdrive: a driver-agnostic, action-only ctx.sql</h3>

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

Integrate an existing Postgres or MySQL database into Lunora from **actions**, through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/). `@lunora/hyperdrive` surfaces the binding's connection string and a driver-agnostic `SqlClient` bound to `ctx.sql` — **on `ActionCtx` only**.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

> ### ⚠️ Integrate, don't replace — read this first
>
> Hyperdrive talks to a database **Lunora does not own**. That breaks two invariants the rest of Lunora relies on:
>
> 1. **Non-deterministic (action-only).** A SQL query over Hyperdrive is a network call with an external, mutable result — exactly like `fetch`. It is **forbidden in `query`/`mutation`** (which must be deterministic so the coordinator can re-run them on OCC retry / subscription re-evaluation) and allowed **only in `action`s**. The `hyperdrive_outside_action` advisor lint flags `ctx.sql` used in a query/mutation.
> 2. **Non-reactive.** External writes do **not** flow through the Durable-Object / SQLite change-feed, so **Lunora live queries and subscriptions will NOT re-run** when an external Postgres/MySQL row changes. There is no honest way to make external writes reactive here.
>
> Use Hyperdrive to _read/write your existing DB from an action_. It is the **wrong** tool for "make my Postgres reactive". If you want external data to be reactive, write a **projection** of it into a `defineSchema` DO/D1 table from the action — that write _is_ tracked.

## Install

```sh
npm install @lunora/hyperdrive
```

```sh
pnpm add @lunora/hyperdrive
```

You bring your own driver — `@lunora/hyperdrive` bundles none (they are `optional` peer deps). Install exactly one of:

```sh
pnpm add postgres   # postgres.js  → fromPostgresJs
pnpm add pg         # node-postgres → fromNodePg
pnpm add mysql2     # mysql2        → fromMysql2
```

## Setup

1. Create the Hyperdrive config and mint its id (Lunora can't fabricate the remote id):

    ```sh
    wrangler hyperdrive create my-db --connection-string="postgres://user:pass@host:5432/db" # gitleaks:allow -- placeholder, not a real secret
    ```

2. Add the binding to `wrangler.jsonc` (use `localConnectionString` for local dev):

    ```jsonc
    {
        "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id from step 1>", "localConnectionString": "postgres://user:pass@localhost:5432/db" }], // gitleaks:allow -- placeholder, not a real secret
    }
    ```

## Usage

`ctx.sql` is wired by codegen onto `ActionCtx` only — never `QueryCtx`/`MutationCtx`. The procedure builders (`action`, `v`) and `api` come from your app-local generated modules:

```ts
import { createHyperdrive, fromPostgresJs } from "@lunora/hyperdrive";
import postgres from "postgres";

import { api } from "@/lunora/_generated/api";
import { action, v } from "@/lunora/_generated/server";

export const syncCustomer = action.input({ orgId: v.string() }).action(async ({ args: { orgId }, ctx }) => {
    const { connectionString } = createHyperdrive(ctx.env.HYPERDRIVE);
    ctx.sql = fromPostgresJs(postgres(connectionString));

    const rows = await ctx.sql.query<{ id: string; name: string }>("select id, name from customers where org = $1", [orgId]);

    // Want it reactive? Project it into a Lunora table — THIS write is tracked.
    await ctx.runMutation(api.customers.upsertMany, { rows });

    return rows;
});
```

`SqlClient` is intentionally minimal — one parameterised `query<Row>(text, params)` — mapping cleanly onto postgres.js, node-postgres and mysql2. The package does not rewrite SQL: use `$1, $2` for Postgres and `?` for MySQL, matching your driver.

| Driver                   | Adapter          | Placeholders |
| ------------------------ | ---------------- | ------------ |
| `postgres` (postgres.js) | `fromPostgresJs` | `$1, $2, …`  |
| `pg` (node-postgres)     | `fromNodePg`     | `$1, $2, …`  |
| `mysql2/promise`         | `fromMysql2`     | `?`          |

## Reactive `.global()` over Hyperdrive

The `@lunora/hyperdrive/global` subpath is the opposite trade-off: Lunora **owns** the schema and a `.global()` table gets a real column-per-field layout on your Postgres/MySQL, with every write routed through the shared store core. Live queries stay reactive — identical to D1 — because the writer drives the same broadcast hook. Build the writer inside the Durable Object that hosts the `.global()` store and inject it as `globalDb`:

```ts
import { createPostgresGlobalCtxDb } from "@lunora/hyperdrive/global";
import postgres from "postgres";

// `sql` is a postgres.js client built from the HYPERDRIVE binding's connection string.
const globalDb = createPostgresGlobalCtxDb({ query: (text, params) => sql.unsafe(text, params) }, { schema });
```

For MySQL use `createMysqlGlobalCtxDb` with a `mysql2/promise` pool created with `flags: ["FOUND_ROWS"]` — without `CLIENT_FOUND_ROWS` the affected-rows OCC guard sees changed (not matched) rows and raises spurious conflicts. Lower-level building blocks (`buildPgExec`, `buildMysqlExec`, `postgresDialect`, `mysqlDialect`, `createHyperdriveGlobalCtxDb`) are exported for custom wiring.

> This README covers the basics. For the full API and the determinism/realtime rationale, see the **[documentation](https://lunora.sh/docs/addons/hyperdrive)**.

## Non-goals

- No logical-replication / CDC ingestion of external Postgres into Lunora tables (the only honest path to a "reactive external DB"; a large, separate effort — out of scope).
- No `ctx.sql` in `query`/`mutation` (forbidden by design; lint-enforced).
- No bundled driver and no opinionated ORM — you own driver choice and lifecycle.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — call `ctx.sql` from actions.
- [`@lunora/d1`](https://www.npmjs.com/package/@lunora/d1) — Lunora-owned, reactive D1 for `.global()` tables.
- [`@lunora/sql-store`](https://www.npmjs.com/package/@lunora/sql-store) — the shared store core behind the reactive `@lunora/hyperdrive/global` backend.
- [`@lunora/advisor`](https://www.npmjs.com/package/@lunora/advisor) — ships the `hyperdrive_outside_action` lint.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/lunora/issues) and check our [Contributing](https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/lunora/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Lunora hyperdrive package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/hyperdrive?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/hyperdrive
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/hyperdrive?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/hyperdrive
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
