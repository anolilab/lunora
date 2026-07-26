/**
 * `@lunora/sql-store` — the internal, dialect-parameterized SQL store core
 * shared by Lunora's `.global()` table backends.
 *
 * One ORM implementation (`createSqlCtxDb`) drives any SQL engine through a
 * `SqlDialect`: SQLite via `@lunora/d1`, and Postgres/MySQL (PlanetScale, Neon,
 * any Hyperdrive-reachable database) via `@lunora/hyperdrive`. Reactivity is
 * unaffected — the writer is injected as `globalDb` into `createShardCtxDb`,
 * whose `broadcast` hook drives live queries regardless of engine.
 *
 * This package is internal: consumers depend on `@lunora/d1` or
 * `@lunora/hyperdrive`, which assemble the concrete dialect and wrap the core.
 */
export type { SqlCtxDbOptions, SqlCtxExec } from "./ctx-db";
export {
    backfillSqlSearchIndexes,
    createSqlCtxDb,
    decodeGlobalRow,
    readSqlCdcChanges,
    runSqlAggregateMigrations,
    runSqlCdcMigration,
    runSqlGlobalTableMigrations,
    runSqlRankMigrations,
    runSqlSearchMigrations,
    trimSqlCdcChanges,
} from "./ctx-db";
export type { SqlDialect, SqlExec, SqlRunResult } from "./dialect";
export { decodeBigint, effectiveColumnKind, sqliteDecode, sqliteEncode, tryJsonParse } from "./value-codec";
