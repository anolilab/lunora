/**
 * One-shot index backfill for the DO store, extracted from `ctx-db.ts`.
 *
 * `backfillAggregateIndexes` / `backfillRankIndexes` populate the aggregate
 * counter and rank companion tables up-front by scanning each source table
 * once — the explicit twins of the reader's lazy `ensureBackfilled` /
 * `ensureRankBackfilled` paths, for tests and production hosts that prefer to
 * pay the backfill cost eagerly. Both are idempotent: a companion that already
 * carries rows is left untouched, so they are safe to call twice.
 *
 * These touch the store only through `SqlExec`; `ctx-db.ts` re-exports the two
 * public entry points so existing import sites (the index barrel, tests) are
 * unchanged.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-backfill" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import { matchesStaticWhere } from "./aggregate-sql";
import type { AggregateTally } from "./aggregate-tally";
import { aggregateTableName, encodeAggregateKey, foldAggregateTally } from "./aggregate-tally";
import type { AggregateIndexDefinitionLike } from "./aggregates";
// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SearchIndexDefinitionLike, SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, DOC_COLUMN, isFtsAvailable, rowToDocument, serializeSqlValue } from "./do-sql";
import { param } from "./drizzle";
import type { RankIndexDefinitionLike } from "./rank";
import { encodePartitionKey, matchesRankStaticWhere, rankTableName, sortColumnName } from "./rank";
import { FTS_ID_COLUMN, FTS_TEXT_COLUMN, ftsTableName, resolveSearchField, stringifySearchText } from "./search-text";

/**
 * Backfill one aggregate counter table by scanning the source rows once and
 * tallying per canonical `by`-key. No-op when the counter already has rows.
 */
const backfillAggregateIndex = (sql: SqlExec, tableName: string, index: AggregateIndexDefinitionLike): void => {
    const aggTable = aggregateTableName(tableName, index.name);
    const existing = runDrizzle<{ count: number }>(sql, dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(aggTable)}`).one();

    if (existing.count > 0) {
        return;
    }

    const by = index.by ?? [];
    const tallies = new Map<string, AggregateTally>();
    const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record || (index.where && !matchesStaticWhere(record, index.where))) {
            continue;
        }

        const encoded = encodeAggregateKey(by, record);

        foldAggregateTally(tallies, encoded, index, record);
    }

    for (const [encoded, tally] of tallies) {
        runDrizzle(
            sql,
            dsql`INSERT INTO ${dsql.identifier(aggTable)} (${AGG_KEY}, ${AGG_VALUE}, ${AGG_COUNT}) VALUES (${encoded}, ${tally.value}, ${tally.count})`,
        );
    }
};

/**
 * One-shot backfill of every declared aggregate index. Used by tests and
 * production hosts that want to populate counters up-front instead of on first
 * read. Idempotent: counter rows that already exist are left alone, so it's
 * safe to call twice.
 *
 * The reader uses `ensureBackfilled` internally for the lazy path; this
 * helper is the explicit twin so callers can opt out of the lazy cost.
 */
const backfillAggregateIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.aggregateIndexes) {
            continue;
        }

        for (const index of definition.aggregateIndexes) {
            backfillAggregateIndex(sql, tableName, index);
        }
    }
};

/**
 * Backfill one rank companion table by scanning the source rows once. No-op
 * when the companion already carries rows.
 */
const backfillRankIndex = (sql: SqlExec, tableName: string, index: RankIndexDefinitionLike): void => {
    const rankTable = rankTableName(tableName, index.name);
    const existing = runDrizzle<{ count: number }>(sql, dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(rankTable)}`).one();

    if (existing.count > 0) {
        return;
    }

    const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
    const columnsSql = dsql.join(
        ["__id__", "__partition__", ...sortColumns].map((column) => dsql.identifier(column)),
        dsql`, `,
    );
    const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record || (index.where && !matchesRankStaticWhere(record, index.where))) {
            continue;
        }

        const partitionKey = encodePartitionKey(index.partitionBy ?? [], record);
        // eslint-disable-next-line unicorn/no-null -- binds the rank sort column to SQLite: a missing sort field is a NULL column value, not undefined
        const sortValues = index.sortBy.map((key) => serializeSqlValue(record[key.field] ?? null));
        const valuesSql = dsql.join(
            [record["_id"] as string, partitionKey, ...sortValues].map((value) => param(value)),
            dsql`, `,
        );

        runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(rankTable)} (${columnsSql}) VALUES (${valuesSql})`);
    }
};

/**
 * One-shot backfill of every declared rank index. The runtime path uses
 * `ensureRankBackfilled` lazily; this is the explicit twin for production
 * hosts that prefer to populate companions up-front. Idempotent: skips
 * rank companions that already carry rows.
 */
const backfillRankIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.rankIndexes) {
            continue;
        }

        for (const index of definition.rankIndexes) {
            backfillRankIndex(sql, tableName, index);
        }
    }
};

/**
 * Index every existing row of `tableName` into one FTS5 shadow table. No-op
 * when the shadow already carries rows, so a search index that has been live
 * (and is trigger-maintained) is never rebuilt from scratch.
 *
 * `runShardMigrations` calls this right after creating a shadow, which is what
 * makes `.searchIndex()` on a table that already holds data searchable
 * immediately. Indexes declared `staged: true` skip that call and are populated
 * only by {@link backfillSearchIndexes}.
 */
const backfillSearchIndex = (sql: SqlExec, tableName: string, index: SearchIndexDefinitionLike): void => {
    const ftName = ftsTableName(tableName, index.name);
    const existing = runDrizzle<{ count: number }>(sql, dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(ftName)}`).one();

    if (existing.count > 0) {
        return;
    }

    const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record) {
            continue;
        }

        runDrizzle(
            sql,
            dsql`INSERT INTO ${dsql.identifier(ftName)} (${dsql.identifier(FTS_TEXT_COLUMN)}, ${dsql.identifier(FTS_ID_COLUMN)}) VALUES (${stringifySearchText(resolveSearchField(record, index.field))}, ${record["_id"] as string})`,
        );
    }
};

/**
 * One-shot backfill of every declared search index, including the `staged: true`
 * ones migrations deliberately leave empty. This is the entry point a host runs
 * out-of-band (a one-shot RPC, a migration step) after deploying a search index
 * over a table too large to index inside the migration pass. Idempotent: shadows
 * that already carry rows are left alone.
 */
const backfillSearchIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.searchIndexes || !isFtsAvailable(sql)) {
            continue;
        }

        for (const index of definition.searchIndexes) {
            backfillSearchIndex(sql, tableName, index);
        }
    }
};

export { backfillAggregateIndexes, backfillRankIndexes, backfillSearchIndex, backfillSearchIndexes };
