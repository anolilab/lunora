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

import type { AggregateIndexDefinitionLike, AggregateTally, RankIndexDefinitionLike } from "@lunora/shard-engine";
import {
    aggregateTableName,
    encodeAggregateKey,
    encodePartitionKey,
    foldAggregateTally,
    matchesRankStaticWhere,
    matchesStaticWhere,
    param,
    rankTableName,
    sortColumnName,
} from "@lunora/shard-engine";
import { sql as dsql } from "drizzle-orm";

// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, DOC_COLUMN, rowToDocument, serializeSqlValue } from "./do-sql";

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

export { backfillAggregateIndexes, backfillRankIndexes };
