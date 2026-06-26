<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="sql-store" />

</a>

<h3 align="center">Internal dialect-parameterized SQL store core for Lunora .global() backends (D1, PlanetScale)</h3>

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

**Internal.** The dialect-parameterized SQL store core shared by Lunora's
`.global()` table backends. One ORM implementation (`createSqlCtxDb`) drives any
SQL engine:

- **SQLite / D1** — via [`@lunora/d1`](../d1)
- **Postgres / MySQL** (PlanetScale, Neon, … over Cloudflare Hyperdrive) — via
  [`@lunora/hyperdrive/global`](../hyperdrive)

You do not depend on this package directly. Depend on `@lunora/d1` or
`@lunora/hyperdrive`, which supply the concrete dialect and wrap the core.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## How it works

The core builds every statement as a composable **drizzle `SQL`** and renders it
for the target engine via drizzle's matching dialect (selected off
`dialect.name`). Drizzle owns identifier quoting (`"..."` vs `` `...` ``) and
placeholder numbering (`?` vs `$N`), so the core stays engine-blind without any
hand-rolled rewriting.

The small per-engine `SqlDialect` value object carries only what drizzle can't
infer from a dynamic, column-per-field schema: the framework columns every
global table carries, column and companion-table types, value encode/decode
(every engine stores SQLite-shaped values), `RETURNING` availability (with an
affected-rows fallback for MySQL), unique-violation detection, the MySQL index
key-prefix, and the system-catalog (`tableExists`) probe. Full-text search is
not part of the dialect — the core probes FTS5 availability on the `exec` at
runtime.

Reactivity is engine-independent: the writer is injected as `globalDb` into
`createShardCtxDb`, whose `broadcast` hook drives live queries no matter which
backend stores the row.

## Public exports

Both subpaths resolve to the same symbols (`./dialect` re-exports the dialect
seam from the root); consumers import everything from the root `@lunora/sql-store`.

- `createSqlCtxDb(options: SqlCtxDbOptions): DatabaseWriterLike` — builds the
  store writer. `options` requires `dialect` and `exec` (the async SQL surface)
  and `schema`; the rest (`auth`, `cdc`, `clock`, `idGenerator`,
  `crossShardReader`/`crossShardCounter`, `maxRelationKeys`, `scheduler`) are
  optional.
- `decodeGlobalRow(definition, row)` — decode a raw stored row back to its JS
  shape via the table definition's validators.
- Migration runners (each takes `(exec, schema, dialect)`, or `(exec, dialect)`
  for CDC): `runSqlGlobalTableMigrations`, `runSqlAggregateMigrations`,
  `runSqlRankMigrations`, `runSqlSearchMigrations`, `runSqlCdcMigration`.
- CDC log helpers: `readSqlCdcChanges`, `trimSqlCdcChanges`.
- Value codec building blocks a dialect reuses for `encode`/`decode`:
  `sqliteEncode`, `sqliteDecode`, `decodeBigint`, `tryJsonParse`,
  `effectiveColumnKind`.
- Types: `SqlCtxDbOptions`, `SqlCtxExec`, `SqlDialect`, `SqlExec`,
  `SqlRunResult`.

Writing a new engine adapter means supplying a `SqlDialect` value (see
[`@lunora/d1`](../d1)'s `sqliteDialect` for the reference) and an `exec` that
satisfies `SqlExec`/`SqlCtxExec`, then calling `createSqlCtxDb`.

## Related

- [`@lunora/d1`](https://www.npmjs.com/package/@lunora/d1) — SQLite/D1 dialect and `exec` wrapping this core.
- [`@lunora/hyperdrive`](https://www.npmjs.com/package/@lunora/hyperdrive) — Postgres/MySQL dialect over Cloudflare Hyperdrive.
- [`@lunora/do`](https://www.npmjs.com/package/@lunora/do) — the shard store whose `broadcast` hook drives live queries.

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

The Lunora sql-store package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/sql-store?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/sql-store
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/sql-store?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/sql-store
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
