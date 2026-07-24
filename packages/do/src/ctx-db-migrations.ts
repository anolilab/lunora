/**
 * Schema migrations for the DO store, extracted from `ctx-db.ts`.
 *
 * `runShardMigrations` brings the Durable Object's SQLite database into the
 * shape declared by `schema`: it creates the per-table `(id, _creationTime,
 * __doc__)` row table and then layers on the secondary/`.unique()` expression
 * indexes, the FTS5 search shadow tables, the aggregate-counter companions, and
 * the rank companion tables + their sorted btree index — finally provisioning
 * the CDC log/epoch (when enabled) and the always-present idempotency table.
 *
 * Every statement is `IF NOT EXISTS`, so the whole pass is idempotent and safe
 * to call on every cold start. Global (`.global()`) tables live in D1, not the
 * DO, so they're skipped here. `ctx-db.ts` re-exports `runShardMigrations` so
 * existing import sites (shard-do, the index barrel, tests) are unchanged.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-migrations" mirrors its parent "ctx-db.ts" (the established public module name). */

import { aggregateTableName, ftsTableName, rankTableName, sortColumnName } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { migrateCdcLog, migrateCdcMeta } from "./ctx-db-cdc";
import { migrateClientWatermark } from "./ctx-db-client-watermark";
import { migrateGlobalShapeSnapshot } from "./ctx-db-global-shape-snapshot";
import { migrateIdempotency } from "./ctx-db-idempotency";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, createIndexSql, DOC_COLUMN, geoTableName, isFtsAvailable, jsonPathSql, tableColumns } from "./do-sql";

/** Create the secondary + `.unique()` expression indexes declared on a table. */
const migrateSecondaryIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    for (const index of definition.indexes) {
        const indexName = `${tableName}_${index.name}`;
        const expressions = dsql.join(
            index.fields.map((field) => jsonPathSql(field)),
            dsql`, `,
        );

        runDrizzle(sql, createIndexSql(indexName, tableName, expressions, index.unique ?? false));
    }

    // `.unique()` columns synthesize a UNIQUE expression index so SQLite
    // enforces the constraint; the write layer maps breaches to ConflictError.
    for (const [field, column] of tableColumns(definition)) {
        if (!column.unique) {
            continue;
        }

        const indexName = `${tableName}_unique_${field}`;

        runDrizzle(sql, createIndexSql(indexName, tableName, jsonPathSql(field), true));
    }
};

/**
 * Create the FTS5 shadow tables for a table's `.searchIndex()` declarations,
 * only on engines that ship FTS5 (Cloudflare DOs do; the `node:sqlite` test
 * runner doesn't, where `.search()` transparently falls back to a scan).
 * `__text__` holds the indexed field; `__id__` (UNINDEXED) joins back to the row.
 */
const migrateSearchIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.searchIndexes || definition.searchIndexes.length === 0 || !isFtsAvailable(sql)) {
        return;
    }

    for (const index of definition.searchIndexes) {
        const ftName = ftsTableName(tableName, index.name);

        runDrizzle(
            sql,
            dsql`CREATE VIRTUAL TABLE IF NOT EXISTS ${dsql.identifier(ftName)} USING fts5(${dsql.identifier("__text__")}, ${dsql.identifier("__id__")} UNINDEXED)`,
        );
    }
};

/**
 * Create the geohash companion tables backing `.geoIndex()` declarations. One
 * row per source row keyed by `__id__`, carrying the geohash prefix plus the raw
 * `__lat__`/`__lng__` so `withGeoIndex(...)` can range-scan by geohash and then
 * Haversine-refine without re-decoding the source doc. A btree on
 * `(__geohash__, __id__)` answers the prefix range scan.
 */
const migrateGeoIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.geoIndexes) {
        return;
    }

    for (const index of definition.geoIndexes) {
        const geoTable = geoTableName(tableName, index.name);

        runDrizzle(
            sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(geoTable)} (${dsql.identifier("__id__")} TEXT PRIMARY KEY, ${dsql.identifier("__geohash__")} TEXT NOT NULL, ${dsql.identifier("__lat__")} REAL NOT NULL, ${dsql.identifier("__lng__")} REAL NOT NULL)`,
        );

        const btreeName = `${tableName}__geo_${index.name}__btree`;

        runDrizzle(sql, createIndexSql(btreeName, geoTable, dsql`${dsql.identifier("__geohash__")} ASC, ${dsql.identifier("__id__")} ASC`, false));
    }
};

/**
 * Create the counter tables backing `aggregateIndex` declarations. One row per
 * distinct `by`-tuple; `__key__` is a canonical-JSON encoding so lookups stay
 * stable. Not populated here — the write path steps every counter and the
 * reader lazily backfills empties on first use (or `backfillAggregateIndexes`).
 */
const migrateAggregateIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.aggregateIndexes) {
        return;
    }

    for (const index of definition.aggregateIndexes) {
        const aggTable = aggregateTableName(tableName, index.name);

        // `__value__` is nullable now (an empty min/max group stores NULL); the
        // pre-reducer-aware shape declared it `NOT NULL` and carried only a row
        // count. `CREATE TABLE IF NOT EXISTS` won't reshape a table that already
        // exists, so the defensive `ADD COLUMN` below upgrades a companion
        // persisted by an older alpha build.
        runDrizzle(
            sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(aggTable)} (${AGG_KEY} TEXT PRIMARY KEY, ${AGG_VALUE} REAL, ${AGG_COUNT} INTEGER NOT NULL DEFAULT 0)`,
        );

        // Alpha-era companion-rebuild caveat: a DO persisted before `__count__`
        // existed gets the column added here (defaulted 0). The first read/write
        // that touches the index re-runs the full backfill (`ensureBackfilled`),
        // so the seeded 0s are overwritten with real per-op values — no stale
        // count survives. We pragma-check rather than blindly ALTER so a fresh
        // table (created above with the column) doesn't raise "duplicate column".
        const columns = runDrizzle<{ name: string }>(sql, dsql`PRAGMA table_info(${dsql.identifier(aggTable)})`).toArray();

        if (!columns.some((column) => column.name === "__count__")) {
            runDrizzle(sql, dsql`ALTER TABLE ${dsql.identifier(aggTable)} ADD COLUMN ${AGG_COUNT} INTEGER NOT NULL DEFAULT 0`);
        }
    }
};

/**
 * Create the rank companion tables + their sorted btree index for a table's
 * `rankIndex` declarations. One row per source row keyed by `__id__`; the index
 * on `(__partition__, __sort_k0__, …, __id__)` answers `rank()` in O(log n).
 */
const migrateRankIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.rankIndexes) {
        return;
    }

    for (const index of definition.rankIndexes) {
        const rankTable = rankTableName(tableName, index.name);
        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnDdls = sortColumns.map((column) => dsql`${dsql.identifier(column)} BLOB`);
        const columnPart = columnDdls.length > 0 ? dsql`, ${dsql.join(columnDdls, dsql`, `)}` : dsql``;

        runDrizzle(
            sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(rankTable)} (${dsql.identifier("__id__")} TEXT PRIMARY KEY, ${dsql.identifier("__partition__")} TEXT NOT NULL${columnPart})`,
        );

        // Sorted btree: (partition, sortBy ASC/DESC..., __id__ ASC)
        const orderedColumns: SQL[] = [dsql`${dsql.identifier("__partition__")} ASC`];

        for (const [i, column] of sortColumns.entries()) {
            const direction = index.sortBy[i]?.direction;

            orderedColumns.push(dsql`${dsql.identifier(column)} ${dsql.raw(direction === "desc" ? "DESC" : "ASC")}`);
        }

        orderedColumns.push(dsql`${dsql.identifier("__id__")} ASC`);

        const btreeName = `${tableName}__rank_${index.name}__btree`;

        runDrizzle(sql, createIndexSql(btreeName, rankTable, dsql.join(orderedColumns, dsql`, `), false));
    }
};

/**
 * Bring the SQLite database into the shape declared by `schema`. Idempotent
 * — every statement uses `IF NOT EXISTS`, so it's safe to call on every
 * cold start.
 *
 * Global tables (`.global()`) live in D1, not in the DO — they're skipped
 * here. The DO sees them via the D1 adapter exposed elsewhere.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { runShardMigrations }`), per the repo's no-default-mixing convention
export const runShardMigrations = (sql: SqlExec, schema: SchemaLike, options: { cdc?: boolean } = {}): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global") {
            continue;
        }

        runDrizzle(
            sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(tableName)} (
                id TEXT PRIMARY KEY,
                _creationTime REAL NOT NULL,
                ${dsql.identifier(DOC_COLUMN)} TEXT NOT NULL
            )`,
        );

        migrateSecondaryIndexes(sql, tableName, definition);
        migrateSearchIndexes(sql, tableName, definition);
        migrateGeoIndexes(sql, tableName, definition);
        migrateAggregateIndexes(sql, tableName, definition);
        migrateRankIndexes(sql, tableName, definition);
    }

    if (options.cdc) {
        migrateCdcLog(sql);
        // The epoch row lives next to the log so a reconnecting subscriber can
        // prove timeline continuity; created upfront (the row itself is minted
        // lazily by `readCdcEpoch` on first frame).
        migrateCdcMeta(sql);
        // Custom mutators imply CDC, so the per-client watermark table rides the
        // same gate: it holds the monotonic `last_mutation_id` the poke protocol
        // echoes back so the client's outbox can drop confirmed pending writes.
        migrateClientWatermark(sql);
    }

    // Always present: the mutation-replay dedup table is independent of CDC and
    // costs nothing until the first id-bearing mutation writes to it.
    migrateIdempotency(sql);

    // Always present: the durable per-socket baseline for `.global()`-shape diff
    // pokes. Independent of CDC (global shapes are polled, not poke-live) and
    // empty until the first global shape is seeded, so a non-global DO pays
    // nothing — but persisting it lets the poll-loop diff survive hibernation.
    migrateGlobalShapeSnapshot(sql);
};
