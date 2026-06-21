# @lunora/sql-store

**Internal.** The dialect-parameterized SQL store core shared by Lunora's
`.global()` table backends. One ORM implementation (`createSqlCtxDb`) drives any
SQL engine:

- **SQLite / D1** — via [`@lunora/d1`](../d1)
- **Postgres / MySQL** (PlanetScale, Neon, … over Cloudflare Hyperdrive) — via
  [`@lunora/hyperdrive/global`](../hyperdrive)

You do not depend on this package directly. Depend on `@lunora/d1` or
`@lunora/hyperdrive`, which supply the concrete dialect and wrap the core.

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
