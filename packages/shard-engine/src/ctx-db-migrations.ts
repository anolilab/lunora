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

import { LunoraError } from "@lunora/errors";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { FTS_ID_COLUMN, FTS_TEXT_COLUMN, ftsTableName } from "@lunora/search-core";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { aggregateTableName } from "./aggregate-tally";
// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { backfillSearchIndexesForTable } from "./ctx-db-backfill";
import { migrateCdcLog, migrateCdcMeta } from "./ctx-db-cdc";
import { migrateClientWatermark } from "./ctx-db-client-watermark";
import { migrateCommitSeq } from "./ctx-db-commit-seq";
import { migrateGlobalShapeSnapshot } from "./ctx-db-global-shape-snapshot";
import { migrateIdempotency } from "./ctx-db-idempotency";
import { migrateRelayShapes } from "./ctx-db-relay-shapes";
import { migrateSearchState } from "./ctx-db-search-state";
import { migrateShapePokeCursor } from "./ctx-db-shape-poke-cursor";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, createIndexSql, DOC_COLUMN, geoTableName, isFtsAvailable, jsonPathSql, tableColumns } from "./do-sql";
import { renderSql } from "./drizzle";
import { migrateDurableStreams } from "./durable-stream";
import { rankTableName, sortColumnName } from "./rank";
import { migrateReactorState } from "./reactor-state";
import { recordSchemaVersion } from "./schema-history";

/**
 * Every filtered read this store emits ends `ORDER BY _creationTime ASC, id ASC`
 * (the default total order; see `compileOrderBySql`). An index on the filter
 * expressions ALONE cannot satisfy that ordering, so SQLite answers
 * `WHERE f = ? ORDER BY _creationTime, id LIMIT n` by reading every matching row
 * into a temp B-tree, sorting it, and returning n:
 *
 * `SEARCH messages USING INDEX messages_by_channel (<expr>=?)` followed by
 * `USE TEMP B-TREE FOR ORDER BY` — sorting every match to return two rows.
 *
 * That makes the most common read in the framework — `.withIndex(f).first()`, a
 * paginated feed — cost O(matching rows) instead of O(limit), and get worse as
 * the table grows rather than staying flat. Measured on `node:sqlite`, a
 * `LIMIT 2` over one key: 35.8us at 250 rows per key, 407.5us at 2500. With the
 * sort keys in the index it is 3.0us and 3.1us — flat, and the temp B-tree is
 * gone from the plan.
 *
 * DESC reads keep the index too (SQLite walks it backwards); only a MIXED
 * direction would still need a partial sort — which is why the implicit `id`
 * tiebreak follows the last sort key's direction (see `tiebreakDirectionFor`),
 * so a descending read stays an index walk rather than producing that shape.
 *
 * The geo and rank companions (below) already index their sort keys. This brings
 * the user-declared index in line with them.
 */
const INDEX_SORT_KEYS = dsql`_creationTime, id`;

/**
 * Drop `indexName` when the index SQLite already holds was built from a
 * different column list than the one we are about to create.
 *
 * `CREATE INDEX IF NOT EXISTS` is a no-op against an index that exists with a
 * DIFFERENT definition — it does not replace it, and it does not complain. So a
 * shard migrated before {@link INDEX_SORT_KEYS} existed would keep its
 * filter-only index forever and never see the improvement, with nothing in any
 * log to say so.
 *
 * The comparison is on the column list SQLite echoes back in `sqlite_master.sql`
 * (it stores the statement verbatim, minus `IF NOT EXISTS`), against the column
 * list we would emit. Comparing the parenthesised tail rather than the whole
 * statement keeps this insensitive to how the surrounding DDL is spelled.
 *
 * ## Cost
 *
 * The rebuild runs synchronously inside the migration, on whichever request
 * happens to open the shard — the same hazard the `__cdc_log` seq index carries,
 * and the reason that one is wrapped in its own try/catch. It is bounded: one
 * rebuild per changed index per shard, once, and a shard's index set is fixed by
 * its schema. A failure here leaves the OLD index in place (the DROP and CREATE
 * are separate statements and the throw propagates), which is the safe
 * direction — a slower index is a working one.
 */
const dropIndexIfShapeChanged = (sql: SqlExec, indexName: string, tableName: string, expressions: SQL, unique: boolean, refs: ReadonlyArray<SQL>): void => {
    const existing = runDrizzle<{ sql: null | string }>(
        sql,
        dsql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${indexName} AND tbl_name = ${tableName}`,
    ).toArray();

    const current = existing[0]?.sql;

    // No row, or an implicit index SQLite created for a constraint (`sql` is
    // NULL there) — nothing of ours to replace.
    if (current === undefined || current === null) {
        return;
    }

    const columnsOf = (statement: string): string | undefined => {
        const open = statement.indexOf("(");

        return open === -1 ? undefined : statement.slice(open, statement.lastIndexOf(")") + 1);
    };

    const wanted = columnsOf(renderSql("sqlite", createIndexSql(indexName, tableName, expressions, unique)).sql);
    const held = columnsOf(current);

    if (wanted === undefined || held === undefined || wanted === held) {
        return;
    }

    // A UNIQUE index is dropped only once the new shape is known to be
    // creatable. Dropping first and letting the follow-up `CREATE UNIQUE INDEX`
    // fail on rows that are duplicates under the NEW column list leaves the
    // table with no constraint at all — and the failed migration re-runs and
    // re-fails on every wake, so the gap never closes on its own. Refusing keeps
    // the old constraint in force and names what has to be de-duplicated.
    //
    // Kept identical to the sql-store twin
    // (`packages/sql-store/src/ctx-db-migrations.ts`) deliberately: the two
    // already carry the same catalog-parsing logic, and a guard on one
    // destructive DDL path but not the other is worse than the duplication.
    if (unique) {
        // Restricted to rows where EVERY indexed column is non-NULL, because the
        // two sides disagree about NULL: `GROUP BY` treats NULLs as equal, a
        // SQLite UNIQUE index treats them as distinct. `json_extract` yields NULL
        // for an unset optional field, so without the filter two rows that simply
        // never set an optional `.unique()` column read as a duplicate, this
        // throws, and a `CREATE UNIQUE INDEX` that would have SUCCEEDED is
        // refused — inside the shard migration, so the shard never opens again.
        const nonNull = dsql.join(
            refs.map((reference) => dsql`${reference} IS NOT NULL`),
            dsql` AND `,
        );
        const duplicates = runDrizzle(
            sql,
            dsql`SELECT 1 FROM ${dsql.identifier(tableName)} WHERE ${nonNull} GROUP BY ${expressions} HAVING COUNT(*) > 1 LIMIT 1`,
        );

        if (duplicates.toArray().length > 0) {
            throw new LunoraError(
                "INTERNAL",
                `unique index "${indexName}" on "${tableName}" cannot be re-created with its new column list: existing rows are duplicates under it. De-duplicate the table with a data migration first; the previous index is left in place.`,
            );
        }
    }

    runDrizzle(sql, dsql`DROP INDEX IF EXISTS ${dsql.identifier(indexName)}`);
};

/**
 * Create the secondary + `.unique()` expression indexes declared on a table.
 *
 * A UNIQUE index does NOT get the sort keys appended: they would become part of
 * what is unique, and `(email, _creationTime, id)` is unique for every row, so
 * the constraint would silently stop rejecting duplicates. That is data
 * corruption rather than a slow query, so the two cases are split deliberately.
 */
const migrateSecondaryIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    for (const index of definition.indexes) {
        const indexName = `${tableName}_${index.name}`;
        const unique = index.unique ?? false;
        const refs = index.fields.map((field) => jsonPathSql(field));
        const fields = dsql.join(refs, dsql`, `);
        const expressions = unique ? fields : dsql`${fields}, ${INDEX_SORT_KEYS}`;

        dropIndexIfShapeChanged(sql, indexName, tableName, expressions, unique, refs);
        runDrizzle(sql, createIndexSql(indexName, tableName, expressions, unique));
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
 *
 * A freshly created shadow is then backfilled from the rows already in the
 * table, so declaring a search index on a table that already holds data makes
 * that data searchable — without it the index would only ever see rows written
 * after* the deploy. `staged: true` opts out for large tables; a host populates
 * those out-of-band with `backfillSearchIndexes`.
 */
const migrateSearchIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.searchIndexes || definition.searchIndexes.length === 0 || !isFtsAvailable(sql)) {
        return;
    }

    for (const index of definition.searchIndexes) {
        const ftName = ftsTableName(tableName, index.name);

        runDrizzle(
            sql,
            dsql`CREATE VIRTUAL TABLE IF NOT EXISTS ${dsql.identifier(ftName)} USING fts5(${dsql.identifier(FTS_TEXT_COLUMN)}, ${dsql.identifier(FTS_ID_COLUMN)} UNINDEXED)`,
        );
        // The vocabulary view over that index: one row per term *instance*, so a
        // term's frequency in a document is a COUNT. It is what lets the reader
        // rank by the shared scorer in SQL instead of approximating it over a
        // bm25-selected window — see `searchViaFts`.
        runDrizzle(
            sql,
            dsql`CREATE VIRTUAL TABLE IF NOT EXISTS ${dsql.identifier(`${ftName}__vocab`)} USING fts5vocab(${dsql.identifier(ftName)}, ${dsql.raw("instance")})`,
        );
    }

    backfillSearchIndexesForTable(sql, tableName, definition);
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
export const runShardMigrations = (
    sql: SqlExec,
    schema: SchemaLike,
    options: { cdc?: boolean; schemaSnapshot?: { hash: string; json: string } } = {},
): void => {
    // Record this schema shape in the version ledger before touching any table.
    // Codegen threads the snapshot it already computes for the deploy gate, so
    // the ledger and the gate can never describe different shapes. Absent (a
    // hand-built DO, or a project on an older codegen) simply means no history.
    if (options.schemaSnapshot !== undefined) {
        recordSchemaVersion(sql, options.schemaSnapshot.hash, options.schemaSnapshot.json);
    }

    // Before any table: the search backfill records its progress here, and it
    // runs inside the per-table pass below.
    migrateSearchState(sql);

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

        // The DEFAULT total order, `_creationTime ASC, id ASC`, which every read
        // that names no `.withIndex()` and no `orderBy` sorts by — `paginate()`,
        // `findMany({ limit })`, `.first()`, and every generated REST list
        // endpoint whose caller sends no filter. The row table above declares
        // only `id TEXT PRIMARY KEY`, so nothing indexed that order and SQLite
        // read the WHOLE table into a temp B-tree to return the first page:
        // `SCAN messages | USE TEMP B-TREE FOR ORDER BY`, 1317.9us over 50k rows
        // against 7.3us on an index walk, and O(table) on every page after the
        // first rather than O(page).
        //
        // Both columns are stored (not `json_extract`) so this is an ordinary
        // btree; it is also what makes the descending read an index walk
        // backwards. See `INDEX_SORT_KEYS` for the DECLARED-index twin of the
        // same problem — this covers the reads that declare no index at all.
        //
        // Cold-start cost: an existing shard builds it once, on the first wake
        // after deploy, inside this migration. Measured on `node:sqlite` over a
        // 1,000,000-row table: 369ms, one sort of 1M `(_creationTime, id)` pairs
        // — both stored columns, so no JSON is decoded. Every request that wakes
        // the shard thereafter pays nothing.
        //
        // Left non-incremental deliberately. A resumable build would need a
        // partial index plus a persisted cursor, and would leave the reads this
        // exists for on the O(table) plan for as long as it ran — which on a
        // table big enough to care is the expensive state, not the build.
        runDrizzle(sql, createIndexSql(`${tableName}__by_creation`, tableName, INDEX_SORT_KEYS, false));

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
        // An op-log-backed (poke-live) shape diffs against `__cdc_log`, so it
        // cannot exist without CDC either — the durable poke-baseline cursor
        // rides the same gate as the log it indexes into.
        migrateShapePokeCursor(sql);
        // Same gate, same reason, for the RELAYED half of that fan-out: an
        // owner's cohort/proxy registry. It lives in SQLite because an owner in
        // relay mode holds no sockets of its own and is evictable between
        // writes — see `ctx-db-relay-shapes.ts`.
        migrateRelayShapes(sql);
    }

    // Gated on the schema, not on a runtime flag: the `_commitSeq` counter is
    // only allocated from by a `.commitOrdered()` table's write path, so a shard
    // whose schema declares none never creates the table. `Object.values` over
    // the table set is the whole probe — `.commitOrdered()` is a static schema
    // fact, unlike CDC (a host option).
    if (Object.values(schema.tables).some((table) => table.commitOrderedMode === true)) {
        migrateCommitSeq(sql);
    }

    // Always present: a reactor's baseline must survive hibernation, and a
    // `.reactor` can be declared without any schema change — so the table has to
    // exist before the first flush, not when a schema flag says so. Empty (and
    // free) on a shard that declares none.
    migrateReactorState(sql);

    // Always present: the mutation-replay dedup table is independent of CDC and
    // costs nothing until the first id-bearing mutation writes to it.
    migrateIdempotency(sql);

    // Always present: the durable per-socket baseline for `.global()`-shape diff
    // pokes. Independent of CDC (global shapes are polled, not poke-live) and
    // empty until the first global shape is seeded, so a non-global DO pays
    // nothing — but persisting it lets the poll-loop diff survive hibernation.
    migrateGlobalShapeSnapshot(sql);

    // Always present: a `.stream()` procedure can be declared `durable` without
    // a schema change, so the transcript tables have to exist before the first
    // one runs. Empty (and free) on a shard that never opens a durable stream.
    migrateDurableStreams(sql);
};
