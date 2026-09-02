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
import { analyzedSearchText, FTS_ID_COLUMN, FTS_TEXT_COLUMN, ftsTableName, planSearchBackfillPass, searchIndexProfile } from "@lunora/search-core";
import { sql as dsql } from "drizzle-orm";

import { matchesStaticWhere } from "./aggregate-sql";
import type { AggregateTally } from "./aggregate-tally";
import { aggregateTableName, encodeAggregateKey, foldAggregateTally } from "./aggregate-tally";
// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SearchIndexDefinitionLike, SqlExec } from "./ctx-db";
import { insertRankRow, rankColumnsSql } from "./ctx-db-companions";
import { migrateSearchState, readSearchBackfillState, readSearchIndexCoverage, writeSearchBackfillState } from "./ctx-db-search-state";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, DOC_COLUMN, isFtsAvailable, rowToDocument, tryRowToDocument } from "./do-sql";
import { isLiveForCompanion } from "./query-args";
import { matchesRankStaticWhere, rankTableName } from "./rank";
import type { AggregateIndexDefinitionLike, RankIndexDefinitionLike } from "./schema-types";

/** One page's outcome: whether the index is now complete, and how many rows it walked. */
interface SearchBackfillPass {
    done: boolean;
    rows: number;
}

/** What one {@link backfillSearchIndexes} call achieved, and whether work remains. */
interface SearchBackfillProgress {
    /** `false` when the page budget ran out before every index finished — call again to resume. */
    done: boolean;
    /** Row-walking pages run by this call (an already-complete index costs none). */
    pages: number;
}

/** True when `table` already carries rows — the backfills' idempotence check. */
const hasRows = (sql: SqlExec, table: string): boolean =>
    runDrizzle<{ count: number }>(sql, dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(table)}`).one().count > 0;

/**
 * Does `tableName` hold anything at all? `LIMIT 1`, not the `COUNT(*)` above:
 * this one runs on the search read path, where counting a large table per read
 * is the cost `staged` exists to avoid in the first place.
 */
const tableHasRows = (sql: SqlExec, table: string): boolean => runDrizzle(sql, dsql`SELECT 1 FROM ${dsql.identifier(table)} LIMIT 1`).toArray().length > 0;

/** One full scan of `tableName`'s stored rows, decoded per row by the caller. */
const scanRows = (sql: SqlExec, tableName: string): Record<string, unknown>[] =>
    runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

/**
 * Backfill one aggregate counter table by scanning the source rows once and
 * tallying per canonical `by`-key. No-op when the counter already has rows.
 *
 * `softField` is the table's soft-delete marker column when it has one:
 * companions tally LIVE rows only, matching the incremental maintenance in
 * `ctx-db-companions`, so the two seeds agree.
 */
const backfillAggregateIndex = (sql: SqlExec, tableName: string, index: AggregateIndexDefinitionLike, softField: string | undefined): void => {
    const aggTable = aggregateTableName(tableName, index.name);

    if (hasRows(sql, aggTable)) {
        return;
    }

    const by = index.by ?? [];
    const tallies = new Map<string, AggregateTally>();
    const rows = scanRows(sql, tableName);

    for (const row of rows) {
        const record = rowToDocument(row);

        if (!record || !isLiveForCompanion(record, softField) || (index.where && !matchesStaticWhere(record, index.where))) {
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
            backfillAggregateIndex(sql, tableName, index, definition.softDeleteMode?.field);
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
 * records where it stopped; the next pass resumes. For a NEW index that means it
 * covers a growing prefix of the table — see {@link searchIndexCoversTable},
 * which is how a reader tells that prefix from an index holding every row.
 */
const SEARCH_BACKFILL_BATCH_ROWS = 500;

/**
 * Index one page of `tableName` into a search companion, resuming from the
 * recorded cursor. Reports `done` when the table is fully indexed, plus the
 * number of rows this pass walked — `0` marks the "already complete" no-op, the
 * one outcome a page-budgeted caller must not charge for.
 *
 * Each document is written DELETE-then-INSERT, so re-running a page (a retry
 * after a crash, two cold starts racing) converges instead of duplicating —
 * which on the FTS5 path would otherwise surface as the *same document twice*
 * in a result set, since that query has no `GROUP BY` to collapse it.
 */
const backfillSearchIndexPage = (sql: SqlExec, tableName: string, index: SearchIndexDefinitionLike): SearchBackfillPass => {
    const ftName = ftsTableName(tableName, index.name);
    // `searchIndexProfile`, not the analyzer's profile alone: the analyzer knows
    // only the language, so re-pointing an index at a different column left every
    // stored row analysed from the abandoned one with nothing detecting it —
    // searching the newly declared column returned nothing while the old one
    // still matched. Shared with the sql-store plane so the two cannot disagree
    // about when a rebuild is owed.
    const profile = searchIndexProfile(index);
    const pass = planSearchBackfillPass(readSearchBackfillState(sql, ftName), profile);

    if (pass.finished) {
        return { done: true, rows: 0 };
    }

    // `pass.wipe` marks a REBUILD: the stored text was analyzed by rules the
    // query side no longer uses (a changed `language`, a new analyzer version),
    // so `pass.cursor` is `undefined` and the walk restarts at the top of the
    // table. It deliberately does NOT empty the companion first. Emptying it
    // took a COMPLETE index down to nothing and then rebuilt it 500 rows a
    // pass — on a 1M-row table, thousands of requests served from an index
    // covering a fraction of the rows, with the read path querying it either
    // way. Each row below is written DELETE-then-INSERT, so the re-walk
    // converges on the new analysis in place while every row keeps serving the
    // old one until its turn: stale analysis on a shrinking suffix, rather than
    // no row at all.
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

    return { done, rows: rows.length };
};

/**
 * Does this search companion hold a row for every document in the table — is a
 * result set read from it whole?
 *
 * Not the same question as "has the backfill finished", and the difference is
 * the reason this is a separate helper rather than `plan(...).finished`. Two
 * unfinished walks reach the read path:
 *
 * A NEW index over a table that already holds rows covers a growing PREFIX
 * (`id ASC`). Every match past the cursor is simply absent, so a read served from
 * it is silently partial. `false`, and the reader refuses.
 *
 * A REBUILDING index — the analyzer profile changed — holds every row already;
 * the re-walk rewrites each one's analysis in place (see
 * {@link backfillSearchIndexPage}, which deliberately does not empty the
 * companion first). Nothing is missing, some rows are analyzed by the previous
 * rules. `true`: refusing here would take search on the table offline for the
 * whole re-walk — 500 rows a read, thousands of reads on a large table, a
 * fleet-wide outage on an `ANALYZER_VERSION` bump — to protect against staleness
 * the rows do not have, and it would make the preserved rows pointless.
 *
 * Recorded rather than inferred: from its second page a rebuild's progress row
 * looks exactly like a new index's, so `covered` carries the distinction (see
 * `ctx-db-search-state`).
 */
const searchIndexCoversTable = (sql: SqlExec, tableName: string, index: SearchIndexDefinitionLike): boolean => {
    const companion = ftsTableName(tableName, index.name);
    // `searchIndexProfile`, not the analyzer's profile alone: the analyzer knows
    // only the language, so re-pointing an index at a different column left every
    // stored row analysed from the abandoned one with nothing detecting it —
    // searching the newly declared column returned nothing while the old one
    // still matched. Shared with the sql-store plane so the two cannot disagree
    // about when a rebuild is owed.
    const profile = searchIndexProfile(index);

    // The finished case first, and on its own: it is every read of a healthy
    // index, and it answers from the same single primary-key lookup the backfill
    // page above already makes.
    if (planSearchBackfillPass(readSearchBackfillState(sql, companion), profile).finished) {
        return true;
    }

    return readSearchIndexCoverage(sql, companion);
};

/**
 * Index one page of every declared search index on `tableName`, unless the index
 * is `staged` over a table that has rows to walk. Called by `runShardMigrations`
 * right after the shadow tables exist, which is what makes `.searchIndex()` on a
 * table that already holds data searchable — and again on every search read, so
 * a warm DO keeps advancing a large table's backfill instead of stopping after
 * one page.
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
        // `staged` keeps the row walk out of the cold start, for tables too large
        // to walk there. A table with no rows is not one of those, and skipping it
        // records nothing — so the index would report no coverage and refuse every
        // search until an operator ran the backfill by hand, on a table where the
        // write path had it complete all along. The page below walks nothing and
        // records that completion, which is the whole cost.
        if (index.staged && tableHasRows(sql, tableName)) {
            continue;
        }

        backfillSearchIndexPage(sql, tableName, index);
    }
};

/**
 * Walk one search index forward until it finishes or `budget` row-walking pages
 * are spent.
 *
 * Only a pass that actually walked rows spends budget: an index already recorded
 * complete returns without touching the store, and charging for that would let a
 * schema whose finished indexes outnumber the budget exhaust it before reaching
 * the one that still needs work — a caller looping on `done` would then never
 * finish.
 */
const backfillSearchIndexPages = (sql: SqlExec, tableName: string, index: SearchIndexDefinitionLike, budget: number): SearchBackfillProgress => {
    let pages = 0;

    for (;;) {
        // Checked BEFORE the page, not after: a page writes 500 rows, so deciding
        // afterwards let a call that arrived with nothing left (the previous index
        // finished on its last allowed page) walk one more and exceed the cap the
        // caller sized to its request budget. A finished index still costs
        // nothing, so the "already complete" indexes ahead of the unfinished one
        // do not spend the budget and a caller looping on `done` still converges.
        if (pages >= budget) {
            return { done: false, pages };
        }

        const pass = backfillSearchIndexPage(sql, tableName, index);

        if (pass.rows > 0) {
            pages += 1;
        }

        if (pass.done) {
            return { done: true, pages };
        }
    }
};

/* eslint-disable no-secrets/no-secrets -- the JSDoc names the sql-store backfill entry point, not a credential */

/**
 * Run every declared search index — including the `staged: true` ones the
 * migration pass skips — forward, by default to completion. This is the
 * entry point a host calls out-of-band (the `__lunora_admin__:backfillSearch`
 * RPC, a migration step) after deploying a search index over a table too large
 * to index a page at a time.
 *
 * SHARD-LOCAL tables only. A `.global()` table lives on the SQL backend and is
 * skipped here; its twin is `backfillSqlSearchIndexes` in `@lunora/sql-store`
 * (reached through the D1/Hyperdrive global writer). Someone who declared
 * `staged: true` on a `.global()` table and ran only the RPC named above would
 * otherwise watch it report zero pages and no error, forever.
 *
 * `maxPages` caps how many row-walking pages one call runs, which is what makes
 * it usable from inside a request: a DO has a wall-clock and CPU budget, and the
 * tables `staged: true` exists for are exactly the ones a run-to-completion loop
 * cannot finish within it. The returned `done` tells the caller whether to come
 * back — progress is durable, so the next call resumes where this one stopped.
 *
 * Idempotent and resumable: an index already recorded as complete is skipped,
 * and an interrupted run picks up from its recorded cursor.
 */
/* eslint-enable no-secrets/no-secrets */
const backfillSearchIndexes = (sql: SqlExec, schema: SchemaLike, options: { maxPages?: number } = {}): SearchBackfillProgress => {
    if (!isFtsAvailable(sql)) {
        // No FTS5 engine means no companions to fill; searches already fall back
        // to a LIKE scan, so there is nothing outstanding to report.
        return { done: true, pages: 0 };
    }

    // The page backfill records its progress in the state table, and this is the
    // entry point a host calls directly — so it cannot assume `runShardMigrations`
    // already ran. "The documented remedy throws unless you happened to migrate
    // first" is not a remedy; the sql-store twin provisions for the same reason.
    migrateSearchState(sql);

    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

    let pages = 0;

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind === "global" || !definition.searchIndexes) {
            continue;
        }

        for (const index of definition.searchIndexes) {
            const progress = backfillSearchIndexPages(sql, tableName, index, maxPages - pages);

            pages += progress.pages;

            if (!progress.done) {
                return { done: false, pages };
            }
        }
    }

    return { done: true, pages };
};

export type { SearchBackfillProgress };
export { backfillAggregateIndexes, backfillRankIndexes, backfillSearchIndexes, backfillSearchIndexesForTable, searchIndexCoversTable };
