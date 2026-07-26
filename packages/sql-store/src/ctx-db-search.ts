/**
 * Full-text search for the `.global()` store, in whichever shape the engine can
 * serve.
 *
 * Two companion layouts sit behind one query surface:
 *
 * - **FTS5 shadow** where the engine ships FTS5 (D1). `__text__` holds the
 *   indexed field, `__id__` (UNINDEXED) joins back to the row, and relevance is
 *   the engine's own bm25 `rank`.
 * - **Portable inverted table** everywhere else — Postgres and MySQL behind
 *   Hyperdrive, plus the `node:sqlite` test runner. One `(token, id,
 *   occurrences)` row per distinct token, btree-indexed on `(token, id)`, so an
 *   exact term is a point lookup and a query's final term is a prefix range
 *   scan. Ranking is `SUM(occurrences)`, which is `scoreDocument` expressed in
 *   SQL — that equality is what keeps results identical across backends.
 *
 * Extracted from `ctx-db.ts` (which was already the largest file in the repo)
 * along the same seam `@lunora/do` uses for its companion/migration/backfill
 * cluster. Everything here reaches the engine through `sql-exec`, never through
 * the store core, so there is no cycle back to `ctx-db.ts`.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-search" mirrors its parent "ctx-db.ts", the established module name in this package. */
/* eslint-disable no-restricted-syntax -- `sql\`…\` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */

import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/do";
import {
    buildFtsMatch,
    countSearchTokens,
    FTS_COUNT_COLUMN,
    FTS_ID_COLUMN,
    FTS_TEXT_COLUMN,
    FTS_TOKEN_COLUMN,
    ftsTableName,
    MAX_INDEXED_TOKENS,
    resolveSearchField,
    stringifySearchText,
    tokenizeSearch,
} from "@lunora/do";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { migrateSearchState, readSearchBackfillState, writeSearchBackfillState } from "./ctx-db-search-state";
import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { columnRefSql, createIndexIfNotExists, decodeRows, forEachRowPaged, isFtsAvailable, queryAll, queryRun, serializeColumnValue } from "./sql-exec";

/** The staged `.withSearchIndex().search()` query the reader executes. */
interface SearchStage {
    definition: SearchIndexDefinitionLike;
    field: string;
    filters: { field: string; value: unknown }[];
    hasQuery: boolean;
    indexName: string;
    query: string;
}

/**
 * Every table a `.global()` companion can be built for. A `.shardBy()` table's
 * rows live in the DOs, so a companion over one could never be populated;
 * schemas authored before the `.global()` flag existed don't set `shardMode` at
 * all and still get theirs (the same allowance the id-probe candidate list
 * makes).
 */
const globalSearchIndexes = function* (schema: SchemaLike): Generator<[string, TableDefinitionLike, SearchIndexDefinitionLike]> {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.searchIndexes;

        if ((definition.shardMode !== undefined && definition.shardMode.kind !== "global") || !indexes) {
            continue;
        }

        for (const index of indexes) {
            yield [tableName, definition, index];
        }
    }
};

/**
 * Run a search via the FTS5 shadow: MATCH the query against the indexed text
 * column, JOIN back to the document table on the stored id, narrow by any
 * `.eq()` filter fields (real columns in this dialect), and order by FTS5's
 * `rank` (bm25 — best first).
 */
const searchViaFts = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const ftName = ftsTableName(tableName, search.indexName);
    // MATCH must target the FTS table (by name or an indexed column), never the
    // bare alias `f` — `f MATCH ?` is a "no such column: f" error in SQLite.
    // We match the indexed `__text__` column so the alias join still works.
    const conditions: SQL[] = [sql`f.${sql.identifier(FTS_TEXT_COLUMN)} MATCH ${buildFtsMatch(tokens)}`];

    for (const filter of search.filters) {
        conditions.push(sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);
    }

    // Soft delete: hide soft-deleted rows from search (qualified to the joined
    // doc table `m`).
    if (definition.softDeleteMode) {
        conditions.push(sql`m.${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

    const query = sql`SELECT m.* FROM ${sql.identifier(ftName)} f JOIN ${sql.identifier(tableName)} m ON m.${sql.identifier("id")} = f.${sql.identifier(FTS_ID_COLUMN)} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY f.rank, m.${sql.identifier("_creationTime")} DESC, m.${sql.identifier("id")} ASC LIMIT ${sql.raw(String(limit))}`;

    return decodeRows(definition, await queryAll(exec, dialect, query));
};

/**
 * The predicate one query term matches a companion token with: an exact
 * equality, except for the query's final term, which matches as a prefix so a
 * search behaves as-you-type. Tokens are `[\p{L}\p{N}]+` by construction, so
 * the `LIKE` pattern carries no wildcard or escape character.
 */
const searchTermPredicate = (token: string, isLast: boolean): SQL =>
    isLast ? sql`${sql.identifier(FTS_TOKEN_COLUMN)} LIKE ${`${token}%`}` : sql`${sql.identifier(FTS_TOKEN_COLUMN)} = ${token}`;

/**
 * Run a search against the portable inverted companion — the path every engine
 * without FTS5 takes.
 *
 * The companion holds one `(token, id, occurrences)` row per distinct token, so
 * the whole query is one indexed read: match any query term, group by document,
 * and keep only documents that matched *every* term. Each term gets its own
 * `SUM(CASE …) > 0` test rather than sharing one first-match `CASE`, because a
 * final prefix term can legitimately be satisfied by the same row as an earlier
 * exact term — `"javascript java"` against a document holding only `javascript`
 * matches both terms, and a single `CASE` would score it into one slot and drop
 * the document, diverging from FTS5 and from `scoreDocument`.
 *
 * `SUM(occurrences)` is that scorer's term-frequency score computed in SQL, so
 * relevance order agrees with the FTS5 path, down to the `_creationTime DESC`
 * then `id` tiebreak.
 */
const searchViaInverted = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const ftName = ftsTableName(tableName, search.indexName);
    const lastIndex = tokens.length - 1;
    // Built once and reused by both clauses, so the "matched anything" filter
    // and the per-term "matched this one" tests cannot drift apart.
    const predicates = tokens.map((token, index) => searchTermPredicate(token, index === lastIndex));
    const anyTerm = sql.join(predicates, sql` OR `);
    const everyTerm = sql.join(
        predicates.map((predicate) => sql`SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END) > 0`),
        sql` AND `,
    );
    const scored = sql`SELECT ${sql.identifier(FTS_ID_COLUMN)}, SUM(${sql.identifier(FTS_COUNT_COLUMN)}) AS ${sql.identifier("__score__")} FROM ${sql.identifier(ftName)} WHERE ${anyTerm} GROUP BY ${sql.identifier(FTS_ID_COLUMN)} HAVING ${everyTerm}`;

    const conditions: SQL[] = [];

    for (const filter of search.filters) {
        conditions.push(sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);
    }

    // Soft delete: hide soft-deleted rows from search.
    if (definition.softDeleteMode) {
        conditions.push(sql`m.${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

    let query = sql`SELECT m.* FROM (${scored}) s JOIN ${sql.identifier(tableName)} m ON m.${sql.identifier("id")} = s.${sql.identifier(FTS_ID_COLUMN)}`;

    if (conditions.length > 0) {
        query = sql`${query} WHERE ${sql.join(conditions, sql` AND `)}`;
    }

    query = sql`${query} ORDER BY s.${sql.identifier("__score__")} DESC, m.${sql.identifier("_creationTime")} DESC, m.${sql.identifier("id")} ASC LIMIT ${sql.raw(String(limit))}`;

    return decodeRows(definition, await queryAll(exec, dialect, query));
};

/** Run a staged search on whichever companion this engine maintains. */
const runSqlSearch = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    stage: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> =>
    (await isFtsAvailable(exec))
        ? searchViaFts(exec, dialect, definition, tableName, stage, limit)
        : searchViaInverted(exec, dialect, definition, tableName, stage, limit);

/**
 * The `(token, occurrences)` rows one document contributes to a portable
 * inverted index, capped at {@link MAX_INDEXED_TOKENS} distinct tokens so a
 * single oversized text column can't turn one row write into hundreds of
 * sequential statements.
 */
const searchRowsForDocument = (document: Record<string, unknown>, index: SearchIndexDefinitionLike): [string, number][] =>
    [...countSearchTokens(stringifySearchText(resolveSearchField(document, index.field)))].slice(0, MAX_INDEXED_TOKENS);

/**
 * One column of the search companion's btree, rendered for the engine.
 *
 * Both columns use the dialect's `key` type, which on MySQL is `VARCHAR(768)` —
 * two of those exceed InnoDB's 3072-byte index limit, so they take the same
 * `(191)` key prefix the rank btree uses (a token is a single word; the prefix
 * never truncates one in practice). Postgres needs the opposite treatment: an
 * explicit `text_pattern_ops` class, or the prefix `LIKE` that resolves the
 * query's final term can't use the btree under a non-C collation.
 */
const searchIndexColumn = (dialect: SqlDialect, column: string): SQL => {
    if (dialect.name === "mysql") {
        return sql`${sql.identifier(column)}(191)`;
    }

    if (dialect.textPatternOperatorClass === undefined) {
        return sql`${sql.identifier(column)}`;
    }

    return sql`${sql.identifier(column)} ${sql.raw(dialect.textPatternOperatorClass)}`;
};

/**
 * Rows per companion `INSERT`. Keeps the bound-parameter count of one statement
 * far under every engine's cap (3 params per row) while still turning a
 * many-token document into a handful of round trips rather than one per token.
 */
const SEARCH_INSERT_CHUNK_ROWS = 50;

/** Replace one document's inverted-index rows, chunked into multi-row INSERTs. */
const writeInvertedRows = async (exec: SqlCtxExec, dialect: SqlDialect, ftName: string, id: string, rows: ReadonlyArray<[string, number]>): Promise<void> => {
    // Delete first, always: this is what makes a write idempotent, so a retried
    // backfill page or two cold starts racing converge on one set of rows
    // instead of doubling them — which on the FTS5 path would surface as the
    // same document twice in a result set.
    await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(ftName)} WHERE ${sql.identifier(FTS_ID_COLUMN)} = ${id}`);

    const columns = sql.join(
        [FTS_TOKEN_COLUMN, FTS_ID_COLUMN, FTS_COUNT_COLUMN].map((column) => sql.identifier(column)),
        sql`, `,
    );

    for (let start = 0; start < rows.length; start += SEARCH_INSERT_CHUNK_ROWS) {
        const values = sql.join(
            rows.slice(start, start + SEARCH_INSERT_CHUNK_ROWS).map(([token, occurrences]) => sql`(${token}, ${id}, ${occurrences})`),
            sql`, `,
        );

        // eslint-disable-next-line no-await-in-loop -- companion writes run sequentially on the single shared connection, like every other write path here.
        await queryRun(exec, dialect, sql`INSERT INTO ${sql.identifier(ftName)} (${columns}) VALUES ${values}`);
    }
};

/** Replace one document's FTS5 shadow row. Delete-then-insert, for the same idempotency reason. */
const writeShadowRow = async (exec: SqlCtxExec, dialect: SqlDialect, ftName: string, id: string, text: string): Promise<void> => {
    await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(ftName)} WHERE ${sql.identifier(FTS_ID_COLUMN)} = ${id}`);
    await queryRun(
        exec,
        dialect,
        sql`INSERT INTO ${sql.identifier(ftName)} (${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)}) VALUES (${text}, ${id})`,
    );
};

/**
 * Index one document into one companion, in whichever layout this engine uses.
 * Shared by the write path and the backfill so a row indexed by either is
 * byte-identical.
 */
const indexDocument = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    ftName: string,
    id: string,
    document: Record<string, unknown>,
    index: SearchIndexDefinitionLike,
    ftsAvailable: boolean,
): Promise<void> => {
    if (ftsAvailable) {
        await writeShadowRow(exec, dialect, ftName, id, stringifySearchText(resolveSearchField(document, index.field)));

        return;
    }

    await writeInvertedRows(exec, dialect, ftName, id, searchRowsForDocument(document, index));
};

/**
 * Rows indexed per backfill pass. `ensureMigrated` runs once per ctx-db — per
 * request on a Hyperdrive binding — so a pass has to fit comfortably inside a
 * request budget. Indexing a page at a time means a large table becomes
 * searchable progressively rather than blocking the first request after deploy
 * behind a full-table walk.
 */
const SEARCH_BACKFILL_BATCH_ROWS = 200;

/**
 * Index one page of `tableName` into a search companion, resuming from the
 * recorded cursor. Returns `true` when the table is fully indexed.
 *
 * Progress is read from and written to the state table rather than inferred
 * from the companion's contents: a companion that has been live for a while is
 * non-empty because *writes* filled it, so "has rows" would report an
 * un-backfilled index as complete and permanently strand every row that
 * predates the index — exactly the rows the backfill exists to reach.
 */
const backfillSearchIndexPage = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
    ftsAvailable: boolean,
): Promise<boolean> => {
    const ftName = ftsTableName(tableName, index.name);
    const state = await readSearchBackfillState(exec, dialect, ftName);

    if (state.done) {
        return true;
    }

    // The source table may not exist yet — the companion DDL runs for every
    // table the schema declares without a shard mode, and a host that manages
    // its own DDL may not have created this one. Record completion so this stays
    // a one-time probe rather than a per-request one.
    const sourceRows = await queryAll(exec, dialect, dialect.tableExists(tableName));

    if (sourceRows.length === 0) {
        await writeSearchBackfillState(exec, dialect, ftName, undefined, true);

        return true;
    }

    let indexed = 0;
    let lastId = state.cursor;

    await forEachRowPaged(
        exec,
        dialect,
        definition,
        tableName,
        async (document) => {
            const id = document["_id"];

            if (typeof id !== "string") {
                return;
            }

            lastId = id;
            indexed += 1;

            await indexDocument(exec, dialect, ftName, id, document, index, ftsAvailable);
        },
        { after: state.cursor, limit: SEARCH_BACKFILL_BATCH_ROWS },
    );

    const done = indexed < SEARCH_BACKFILL_BATCH_ROWS;

    await writeSearchBackfillState(exec, dialect, ftName, lastId, done);

    return done;
};

/**
 * Materialize the `__fts_&lt;index>` companion for every declared `.searchIndex()`
 * on a global table, then index one page of the rows that predate it (unless
 * the index is declared `staged: true`, which leaves the whole backfill to
 * {@link backfillSqlSearchIndexes}).
 *
 * Idempotent (`CREATE … IF NOT EXISTS` throughout, and the backfill resumes
 * from recorded progress).
 */

/**
 * Materialize the companion tables (and the progress table they report into)
 * for every declared search index. Split out because both entry points below
 * need it: the migration pass, and the out-of-band runner a host may call
 * before any ctx-db has migrated this binding.
 */
const ensureSearchCompanions = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    await migrateSearchState(exec, dialect);

    const ftsAvailable = await isFtsAvailable(exec);
    const { integer, key } = dialect.companionTypes;

    for (const [tableName, , index] of globalSearchIndexes(schema)) {
        const ftName = ftsTableName(tableName, index.name);

        if (ftsAvailable) {
            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially on the single shared connection.
            await queryRun(
                exec,
                dialect,
                sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(ftName)} USING fts5(${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)} UNINDEXED)`,
            );
        } else {
            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially; the table must exist before its indexes below.
            await queryRun(
                exec,
                dialect,
                sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(ftName)} (${sql.identifier(FTS_TOKEN_COLUMN)} ${sql.raw(key)} NOT NULL, ${sql.identifier(FTS_ID_COLUMN)} ${sql.raw(key)} NOT NULL, ${sql.identifier(FTS_COUNT_COLUMN)} ${sql.raw(integer)} NOT NULL)`,
            );

            // Not unique: a concurrent cold-start backfill could briefly double
            // a row, which the delete-then-insert write repairs, whereas a
            // unique violation would fail the request outright.
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
            await createIndexIfNotExists(exec, dialect, {
                columns: sql`${searchIndexColumn(dialect, FTS_TOKEN_COLUMN)}, ${searchIndexColumn(dialect, FTS_ID_COLUMN)}`,
                name: `${ftName}__btree`,
                table: ftName,
                unique: false,
            });

            // Every row write purges its old rows by id first.
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
            await createIndexIfNotExists(exec, dialect, {
                columns: searchIndexColumn(dialect, FTS_ID_COLUMN),
                name: `${ftName}__by_id`,
                table: ftName,
                unique: false,
            });
        }
    }
};

/**
 * Provision the search companions, then index one bounded page of the rows that
 * predate each index — unless it is declared `staged: true`, which leaves the
 * whole backfill to {@link backfillSqlSearchIndexes}.
 *
 * Idempotent (`CREATE … IF NOT EXISTS` throughout, and the backfill resumes
 * from recorded progress).
 */
const runSqlSearchMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    await ensureSearchCompanions(exec, schema, dialect);

    const ftsAvailable = await isFtsAvailable(exec);

    for (const [tableName, definition, index] of globalSearchIndexes(schema)) {
        if (index.staged) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- backfill pages run sequentially on the shared connection.
        await backfillSearchIndexPage(exec, dialect, definition, tableName, index, ftsAvailable);
    }
};

/**
 * Run every declared search index — including the `staged: true` ones the
 * migration pass skips — through to completion. The entry point a host calls
 * out-of-band after deploying a search index over a table too large to index a
 * page at a time.
 *
 * Idempotent and resumable: an index recorded as complete is skipped, and an
 * interrupted run picks up from its cursor.
 */
const backfillSqlSearchIndexes = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    // Self-sufficient: a host may run this before any ctx-db has migrated this
    // binding, and "the documented remedy throws unless you happened to migrate
    // first" is not a remedy.
    await ensureSearchCompanions(exec, schema, dialect);

    const ftsAvailable = await isFtsAvailable(exec);

    for (const [tableName, definition, index] of globalSearchIndexes(schema)) {
        let done = false;

        while (!done) {
            // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential: each resumes from the prior page's cursor.
            done = await backfillSearchIndexPage(exec, dialect, definition, tableName, index, ftsAvailable);
        }
    }
};

/**
 * Build the write-path hook that keeps a table's search companions in step with
 * a row write. A no-op when the table declares no search indexes;
 * `document === undefined` (a row removal) deletes only.
 */
const createSearchSync = (deps: {
    dialect: SqlDialect;
    exec: SqlCtxExec;
    schema: SchemaLike;
}): ((tableName: string, id: string, document: Record<string, unknown> | undefined) => Promise<void>) => {
    const { dialect, exec, schema } = deps;

    return async (tableName, id, document) => {
        const indexes = schema.tables[tableName]?.searchIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        const ftsAvailable = await isFtsAvailable(exec);

        for (const index of indexes) {
            const ftName = ftsTableName(tableName, index.name);

            if (document) {
                // eslint-disable-next-line no-await-in-loop -- companion writes run sequentially on the shared connection so DELETE/INSERT pairs don't interleave across indexes.
                await indexDocument(exec, dialect, ftName, id, document, index, ftsAvailable);

                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential companion write on the shared connection (see above).
            await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(ftName)} WHERE ${sql.identifier(FTS_ID_COLUMN)} = ${id}`);
        }
    };
};

export type { SearchStage };
export { backfillSqlSearchIndexes, createSearchSync, runSqlSearch, runSqlSearchMigrations };
