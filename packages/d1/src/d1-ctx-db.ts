/**
 * D1 binding of the shared `@lunora/sql-store` core.
 *
 * The dialect-parameterized store core now lives in `@lunora/sql-store`
 * (`createSqlCtxDb` + the `runSql*Migrations`/CDC helpers + `decodeGlobalRow`).
 * This module is the thin D1 wrapper: it injects the {@link sqliteDialect} so
 * the historical `createD1CtxDb` / `runD1*Migrations` surface keeps working
 * unchanged for D1 callers (the codegen-emitted worker, the studio introspector,
 * admin export/import, and the test suite).
 */
/* eslint-disable unicorn/prevent-abbreviations -- "d1-ctx-db" is the established public module name: src/index.ts, introspect/admin, and every test import it as "./d1-ctx-db". */
import type { SchemaLike } from "@lunora/shard-engine";
import type { SqlCtxDbOptions, SqlCtxExec } from "@lunora/sql-store";
import {
    backfillSqlSearchIndexes,
    createSqlCtxDb,
    readSqlCdcChanges,
    runSqlAggregateMigrations,
    runSqlCdcMigration,
    runSqlGlobalTableMigrations,
    runSqlRankMigrations,
    runSqlSearchMigrations,
    sweepSqlCdcRetention,
} from "@lunora/sql-store";

import sqliteDialect from "./sqlite-dialect";

/** The D1 store options — the shared store options minus `dialect` (the SQLite dialect is injected for you). */
type D1ContextDatabaseOptions = Omit<SqlCtxDbOptions, "dialect">;

/** Build a D1-backed `.global()` writer (the shared store core bound to the SQLite dialect). */
const createD1ContextDatabase = (options: D1ContextDatabaseOptions): ReturnType<typeof createSqlCtxDb> =>
    createSqlCtxDb({ ...options, dialect: sqliteDialect });

/** Auto-provision the schema's `.global()` tables in D1 (idempotent `CREATE TABLE IF NOT EXISTS`). */
const runD1GlobalTableMigrations = (exec: SqlCtxExec, schema: SchemaLike): Promise<void> => runSqlGlobalTableMigrations(exec, schema, sqliteDialect);

/** Materialize the `__agg_<index>` companion tables for the schema's aggregate indexes. */
const runD1AggregateMigrations = (exec: SqlCtxExec, schema: SchemaLike): Promise<void> => runSqlAggregateMigrations(exec, schema, sqliteDialect);

/** Materialize the `__rank_<index>` companion tables for the schema's rank indexes. */
const runD1RankMigrations = (exec: SqlCtxExec, schema: SchemaLike): Promise<void> => runSqlRankMigrations(exec, schema, sqliteDialect);

/** Materialize (and backfill) the `__fts_<index>` fts5 shadow tables for the schema's search indexes. */
const runD1SearchMigrations = (exec: SqlCtxExec, schema: SchemaLike): Promise<void> => runSqlSearchMigrations(exec, schema, sqliteDialect);

/** Index existing rows into every search companion, including the `staged: true` ones migrations leave empty. */
const backfillD1SearchIndexes = (exec: SqlCtxExec, schema: SchemaLike): Promise<void> => backfillSqlSearchIndexes(exec, schema, sqliteDialect);

/** Create the `__cdc_log` table in D1 (idempotent; only run when CDC is enabled). */
const runD1CdcMigration = (exec: SqlCtxExec): Promise<void> => runSqlCdcMigration(exec, sqliteDialect);

/** Read changelog entries newer than `sinceSeq` in commit order. */
const readD1CdcChanges = (exec: SqlCtxExec, options: { limit?: number; sinceSeq?: number } = {}): ReturnType<typeof readSqlCdcChanges> =>
    readSqlCdcChanges(exec, options, sqliteDialect);

/**
 * Delete `.global()` changelog entries older than `retentionMs`, if this writer
 * wins the fleet's sweep lease. See `sweepSqlCdcRetention`.
 *
 * Replaces the seq-based `trimD1CdcChanges`, which took a checkpoint no caller
 * could compute: the log is shared across every shard and region, so no single
 * caller knows a `seq` that is safe for all of them. A time window is a bound
 * they can all reason about, and the lease is what stops them racing.
 */
const sweepD1CdcRetention = (exec: SqlCtxExec, retentionMs: number, now: number): Promise<void> => sweepSqlCdcRetention(exec, sqliteDialect, retentionMs, now);

export type { SqlCtxExec as D1Exec, SqlCtxDbOptions, SqlCtxExec } from "@lunora/sql-store";
export { createSqlCtxDb, decodeGlobalRow } from "@lunora/sql-store";
export {
    backfillD1SearchIndexes,
    createD1ContextDatabase as createD1CtxDb,
    readD1CdcChanges,
    runD1AggregateMigrations,
    runD1CdcMigration,
    runD1GlobalTableMigrations,
    runD1RankMigrations,
    runD1SearchMigrations,
    sweepD1CdcRetention,
};
export type { D1ContextDatabaseOptions as D1CtxDbOptions };
