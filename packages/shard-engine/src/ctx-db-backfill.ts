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

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { analyzedSearchText, createSearchAnalyzer, FTS_ID_COLUMN, FTS_TEXT_COLUMN, ftsTableName, planSearchBackfillPass } from "@lunora/search-core";
import { sql as dsql } from "drizzle-orm";

import { matchesStaticWhere } from "./aggregate-sql";
import type { AggregateTally } from "./aggregate-tally";
import { aggregateTableName, encodeAggregateKey, foldAggregateTally } from "./aggregate-tally";
// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SearchIndexDefinitionLike, SqlExec } from "./ctx-db";
import { insertRankRow, rankColumnsSql } from "./ctx-db-companions";
import { migrateSearchState, readSearchBackfillState, writeSearchBackfillState } from "./ctx-db-search-state";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, DOC_COLUMN, isFtsAvailable, rowToDocument, tryRowToDocument } from "./do-sql";
import { matchesRankStaticWhere, rankTableName } from "./rank";
import type { AggregateIndexDefinitionLike, RankIndexDefinitionLike } from "./schema-types";

/** True when `table` already carries rows — the backfills' idempotence check. */
const hasRows = (sql: SqlExec, table: string): boolean =>
    runDrizzle<{ count: number }>(sql, dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(table)}`).one().count > 0;

/** One full scan of `tableName`'s stored rows, decoded per row by the caller. */
const scanRows = (sql: SqlExec, tableName: string): Record<string, unknown>[] =>
    runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

/**
 * Backfill one aggregate counter table by scanning the source rows once and
 * tallying per canonical `by`-key. No-op when the counter already has rows.
 */
const backfillAggregateIndex = (sql: SqlExec, tableName: string, index: AggregateIndexDefinitionLike): void => {
    const aggTable = aggregateTableName(tableName, index.name);

    if (hasRows(sql, aggTable)) {
        return;
    }

    const by = index.by ?? [];
    const tallies = new Map<string, AggregateTally>();
    const rows = scanRows(sql, tableName);

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

    if (hasRows(sql, rankTable)) {
        return;
    }

    const columnsSql = rankColumnsSql(index);
    const rows = scanRows(sql, tableName);

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record || (index.where && !matchesRankStaticWhere(record, index.where))) {
            continue;
        }

        insertRankRow(sql, rankTable, index, columnsSql, record["_id"] as string, record);
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
 * One page of a search backfill: `SEARCH_BACKFILL_BATCH_ROWS` documents in `id`
 * order, starting after `cursor`.
 *
 * Bounded on purpose. A DO cold start runs `runShardMigrations` synchronously
 * inside a 128 MB isolate, so materialising a whole table there is how a large
 * table turns into an eviction loop. Instead each pass indexes a page and
 * records where it stopped; the next pass resumes. The index is usable
 * throughout — it simply covers a growing prefix of the table.
 */
const SEARCH_BACKFILL_BATCH_ROWS = 500;

/**
 * Index one page of `tableName` into a search companion, resuming from the
 * recorded cursor. Returns `true` when the table is fully indexed.
 *
 * Each document is written DELETE-then-INSERT, so re-running a page (a retry
 * after a crash, two cold starts racing) converges instead of duplicating —
 * which on the FTS5 path would otherwise surface as the *same document twice*
 * in a result set, since that query has no `GROUP BY` to collapse it.
 */
const backfillSearchIndexPage = (sql: SqlExec, tableName: string, index: SearchIndexDefinitionLike): boolean => {
    const ftName = ftsTableName(tableName, index.name);
    const { profile } = createSearchAnalyzer(index.language);
    const pass = planSearchBackfillPass(readSearchBackfillState(sql, ftName), profile);

    if (pass.finished) {
        return true;
    }

    if (pass.wipe) {
        // Stored text was analyzed by rules the query side no longer uses (a
        // changed `language`, a new analyzer version) — discard and re-walk.
        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(ftName)}`);
    }

    const { cursor } = pass;
    const rows = runDrizzle(
        sql,
        cursor === undefined
            ? dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)} ORDER BY id ASC LIMIT ${dsql.raw(String(SEARCH_BACKFILL_BATCH_ROWS))}`
            : dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)} WHERE id > ${cursor} ORDER BY id ASC LIMIT ${dsql.raw(String(SEARCH_BACKFILL_BATCH_ROWS))}`,
    ).toArray();

    // Seeded from the resume point, never from nothing: a page whose rows all
    // fail the id check would otherwise write back an empty cursor and send the
    // next pass to the start of the table — forever, since a full page also
    // reports "not done".
    let lastId = cursor;

    for (const row of rows) {
        const { id } = row;

        if (typeof id !== "string") {
            continue;
        }

        lastId = id;

        // Drop whatever the companion still holds for this id first: the
        // DELETE-then-INSERT makes re-running a page converge, and on an
        // unparseable document it clears a stale row serving text the
        // document no longer has — worse than the row being unsearchable.
        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(ftName)} WHERE ${dsql.identifier(FTS_ID_COLUMN)} = ${id}`);

        // Safe-parsing, not `rowToDocument`: this runs inside
        // `runShardMigrations`, so an unparseable document would brick the
        // whole shard's cold start. The cursor still advances past it, so the
        // pass makes progress.
        const record = tryRowToDocument(row);

        if (!record) {
            continue;
        }

        runDrizzle(
            sql,
            dsql`INSERT INTO ${dsql.identifier(ftName)} (${dsql.identifier(FTS_TEXT_COLUMN)}, ${dsql.identifier(FTS_ID_COLUMN)}) VALUES (${analyzedSearchText(record, index)}, ${id})`,
        );
    }

    const done = rows.length < SEARCH_BACKFILL_BATCH_ROWS;

    writeSearchBackfillState(sql, ftName, lastId, done, profile);

    return done;
};

/**
 * Index one page of every declared search index on `tableName`, unless the
 * index is `staged`. Called by `runShardMigrations` right after the shadow
 * tables exist, which is what makes `.searchIndex()` on a table that already
 * holds data searchable — and again on every search read, so a warm DO keeps
 * advancing a large table's backfill instead of stopping after one page.
 *
 * The FTS5 guard is load-bearing on that second call site. Migration only
 * creates the shadow tables where the engine has FTS5, so on an engine without
 * it (searches fall back to a LIKE scan over the document table) there is no
 * companion to write to and every statement below would raise "no such table"
 * — turning a working fallback into a search surface that throws on every read.
 */
const backfillSearchIndexesForTable = (sql: SqlExec, tableName: string, definition: { searchIndexes?: ReadonlyArray<SearchIndexDefinitionLike> }): void => {
    if (!isFtsAvailable(sql)) {
        return;
    }

    for (const index of definition.searchIndexes ?? []) {
        if (index.staged) {
            continue;
        }

        backfillSearchIndexPage(sql, tableName, index);
    }
};

/**
 * Run every declared search index — including the `staged: true` ones the
 * migration pass skips — through to completion. The entry point a host calls
 * out-of-band (a one-shot admin RPC, a migration step) after deploying a search
 * index over a table too large to index a page at a time.
 *
 * Idempotent and resumable: an index already recorded as complete is skipped,
 * and an interrupted run picks up from its recorded cursor.
 */
const backfillSearchIndexes = (sql: SqlExec, schema: SchemaLike): void => {
    if (!isFtsAvailable(sql)) {
        return;
    }

    // The page backfill records its progress in the state table, and this is the
    // entry point a host calls directly — so it cannot assume `runShardMigrations`
    // already ran. "The documented remedy throws unless you happened to migrate
    // first" is not a remedy; the sql-store twin provisions for the same reason.
    migrateSearchState(sql);

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.searchIndexes) {
            continue;
        }

        for (const index of definition.searchIndexes) {
            let done = false;

            while (!done) {
                done = backfillSearchIndexPage(sql, tableName, index);
            }
        }
    }
};

export { backfillAggregateIndexes, backfillRankIndexes, backfillSearchIndexes, backfillSearchIndexesForTable };
