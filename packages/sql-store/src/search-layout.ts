/**
 * The three physical layouts a `.global()` search index can take, behind one
 * interface.
 *
 * A search index is stored one of three ways, and which one is not the caller's
 * business: an FTS5 shadow where the engine ships FTS5, the engine's own
 * full-text index where the schema opted into `strategy: "native"` and the
 * dialect has one, and the portable `(token, id, occurrences)` inverted table
 * otherwise. Each layout answers the same three questions — how do I create it,
 * how do I write one document into it, how do I read it — so they are three
 * implementations of one interface rather than three-way conditionals repeated
 * at each of those points.
 *
 * That repetition is what this file removes. Before it, the DDL, the write path
 * and the read path each re-derived the layout with a differently-spelled
 * if/else, and adding a fourth would have meant finding all three.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "search-layout" sits beside "ctx-db-search", the established module naming in this package. */
/* eslint-disable no-restricted-syntax -- `sql`…`` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import {
    analyzedSearchText,
    countSearchTokens,
    createSearchAnalyzer,
    FTS_COUNT_COLUMN,
    FTS_ID_COLUMN,
    FTS_TOKEN_COLUMN,
    ftsTableName,
    searchIndexProfile,
    searchTermRange,
    tokenizeSearch,
} from "@lunora/search-core";
import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/shard-engine";
import { ftsCompanionDdl, ftsPurgeDocument, ftsUnmappedPage, ftsWriteDocument, groupUnmappedRows, unionAll } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { readSearchBackfillState, writeSearchBackfillState } from "./ctx-db-search-state";
import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import {
    columnRefSql,
    createIndexIfNotExists,
    decodeRow,
    decodeRows,
    nullSafeEqualsSql,
    OCC_VERSION_COLUMN,
    queryAll,
    queryRun,
    runInOrder,
    serializeColumnValue,
} from "./sql-exec";

/** The staged `.withSearchIndex().search()` query a layout executes. */
interface SearchStage {
    definition: SearchIndexDefinitionLike;
    field: string;
    filters: { field: string; value: unknown }[];
    hasQuery: boolean;
    indexName: string;
    query: string;
}

/**
 * One storage layout for a search companion. Every member takes the resolved
 * companion table name, so no implementation re-derives it.
 */
interface SearchLayout {
    /** Create the companion (and its indexes). Idempotent. */
    ensureCompanion: (exec: SqlCtxExec, dialect: SqlDialect, companion: string) => Promise<void>;

    /**
     * Replace one document's rows in the companion, from `document` — the state
     * of the source row `readAs`. The FTS5 and inverted layouts land the write
     * only while that row is still current ({@link unchangedSince}), checked
     * inside the write, so a writer that lost a race to a newer one cannot
     * overwrite its entry. The native layout writes regardless.
     */
    indexDocument: (
        exec: SqlCtxExec,
        dialect: SqlDialect,
        companion: string,
        document: Record<string, unknown>,
        index: SearchIndexDefinitionLike,
        readAs: SourceRow,
    ) => Promise<void>;

    /**
     * Identity of this layout, recorded with the companion's backfill progress.
     * A companion built for one layout holds different *columns* than another,
     * so a change here has to be detected and rebuilt rather than written into.
     */
    readonly name: "fts5" | "inverted" | "native";

    /**
     * Delete every companion row for one document, which was just deleted from
     * `table`. The FTS5 and inverted layouts purge only while no row with that
     * id is back in `table`, so a delete whose purge lands after a re-insert
     * does not drop the new document's entry.
     */
    purgeDocument: (exec: SqlCtxExec, dialect: SqlDialect, companion: string, id: string, table: string) => Promise<void>;

    /** Execute a staged search against this companion, ordered and bounded. */
    runSearch: (
        exec: SqlCtxExec,
        dialect: SqlDialect,
        definition: TableDefinitionLike,
        tableName: string,
        search: SearchStage,
        limit: number,
    ) => Promise<Record<string, unknown>[]>;
}

/** A source-table row exactly as it was read, with the table it was read from. */
interface SourceRow {
    row: Record<string, unknown>;
    table: string;
}

/**
 * The columns that say whether a source row changed since it was read: every
 * guarded write bumps `_version`, and `_creationTime` tells a delete-and-reinsert
 * under the same id apart, whose version restarts at NULL. Read by both the SQL
 * guard ({@link unchangedSince}) and the backfill's re-check.
 */
const ROW_VERSION_COLUMNS: ReadonlyArray<string> = [OCC_VERSION_COLUMN, "_creationTime"];

/** `<table>.<column>`, qualified so an unknown name errors instead of reading as a string. */
const qualified = (table: string, name: string): SQL => sql`${sql.identifier(table)}.${sql.identifier(name)}`;

/** Delete every companion row for one document by its `__id__` column, where `guard` holds. */
const purgeStatement = (companion: string, id: string, guard?: SQL): SQL =>
    sql`DELETE FROM ${sql.identifier(companion)} WHERE ${qualified(companion, FTS_ID_COLUMN)} = ${id}${guard === undefined ? sql`` : sql` AND ${guard}`}`;

/**
 * The source row `readAs` still holds, by {@link ROW_VERSION_COLUMNS}, as a
 * `SELECT 1`: empty once another writer has moved the row on.
 *
 * On Postgres the read takes a share lock. A plain read sees the version as of
 * the statement's start, so a writer that moved the row while this statement
 * ran could purge before this statement's rows were committed — a Postgres
 * `DELETE` never sees rows committed after its own snapshot — and leave them
 * behind. Under the lock that writer's `UPDATE` waits until this statement
 * commits; if it got there first, this read waits for it and then finds the new
 * version. MySQL needs no lock: its `DELETE` reads the latest rows, waiting on
 * uncommitted ones, so the newer writer's purge always removes these. SQLite
 * (D1) runs one writer at a time.
 */
const sourceRowStill = (dialect: SqlDialect, { row, table }: SourceRow): SQL => {
    const matches = ROW_VERSION_COLUMNS.map(
        // eslint-disable-next-line unicorn/no-null -- SQL bind value: a NULL column compares NULL-safely
        (column) => sql` AND ${nullSafeEqualsSql(dialect.name, qualified(table, column), row[column] ?? null)}`,
    );

    return sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${qualified(table, "id")} = ${row["id"]}${sql.join(matches)}${dialect.name === "postgres" ? sql` FOR SHARE` : sql``}`;
};

/** Whether the source row is still the one that was read — {@link sourceRowStill} as a condition. */
const unchangedSince = (dialect: SqlDialect, readAs: SourceRow): SQL => sql`EXISTS (${sourceRowStill(dialect, readAs)})`;

/** Whether no row with `id` is in `table` — the guard on a purge after a delete. */
const absentFrom = (table: string, id: string): SQL => sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(table)} WHERE ${qualified(table, "id")} = ${id})`;

/**
 * One column of the portable companion's indexes, rendered for the engine.
 *
 * Both columns use the dialect's `key` type, which on MySQL is `VARCHAR(768)` —
 * two of those exceed InnoDB's 3072-byte index limit, so each takes a key
 * prefix of `mysqlPrefix` characters. Postgres needs the opposite treatment: an
 * explicit `text_pattern_ops` class, or the prefix `LIKE` that resolves the
 * query's final term can't use the index under a non-C collation.
 */
const invertedIndexColumn = (dialect: SqlDialect, column: string, mysqlPrefix: number): SQL => {
    if (dialect.name === "mysql") {
        return sql`${sql.identifier(column)}(${sql.raw(String(mysqlPrefix))})`;
    }

    if (dialect.textPatternOperatorClass === undefined) {
        return sql`${sql.identifier(column)}`;
    }

    return sql`${sql.identifier(column)} ${sql.raw(dialect.textPatternOperatorClass)}`;
};

/**
 * The unique key of the portable companion: one row per `(token, document)`.
 * It replaces the plain `__btree` index the layout had before (see
 * {@link migrateInvertedUniqueKey}) and serves the same token lookups.
 *
 * On MySQL the token takes a 256-character prefix, which is the analyzer's
 * `MAX_TOKEN_LENGTH`, so uniqueness is exact per token, and the id takes the
 * rest of InnoDB's 3072 bytes (512 characters under utf8mb4).
 *
 * ponytail: two ids that agree on their first 512 characters count as one here,
 * so one of them keeps no rows for a token they share. Widen only if ids that
 * long appear.
 */
const invertedUniqueKey = (dialect: SqlDialect, companion: string): { columns: SQL; name: string; table: string; unique: boolean } => {
    return {
        columns: sql`${invertedIndexColumn(dialect, FTS_TOKEN_COLUMN, 256)}, ${invertedIndexColumn(dialect, FTS_ID_COLUMN, 512)}`,
        name: `${companion}__unique`,
        table: companion,
        unique: true,
    };
};

/**
 * One document's `(token, occurrences)` rows as a row source `j` of `t`/`o`
 * columns, bound as ONE JSON parameter: a document holds up to
 * `MAX_INDEXED_TOKENS` distinct tokens, and one statement per write is what
 * makes the Postgres write atomic.
 */
const tokenRowsSource = (dialect: SqlDialect, counts: ReadonlyArray<[string, number]>): SQL => {
    const json = JSON.stringify(
        counts.map(([t, o]) => {
            return { o, t };
        }),
    );

    switch (dialect.name) {
        case "mysql": {
            return sql`JSON_TABLE(${json}, '$[*]' COLUMNS (${sql.identifier("t")} VARCHAR(256) PATH '$.t', ${sql.identifier("o")} INT PATH '$.o')) AS ${sql.identifier("j")}`;
        }
        case "postgres": {
            return sql`json_to_recordset(${json}::json) AS ${sql.identifier("j")}(${sql.identifier("t")} text, ${sql.identifier("o")} integer)`;
        }
        default: {
            return sql`(SELECT json_extract(${qualified("e", "value")}, '$.t') AS ${sql.identifier("t")}, json_extract(${qualified("e", "value")}, '$.o') AS ${sql.identifier("o")} FROM json_each(${json}) AS ${sql.identifier("e")}) AS ${sql.identifier("j")}`;
        }
    }
};

/**
 * The statements that replace one document's rows in the portable companion,
 * landing only while the source row is still `readAs`.
 *
 * On Postgres it is ONE statement — the purge a data-modifying CTE, the insert
 * waiting on it — so a reader never sees the document half-written, and the
 * share lock {@link sourceRowStill} takes covers both halves. Elsewhere it is a
 * purge and an insert, each carrying the guard: {@link runInOrder} runs them as
 * one transaction on SQLite, and on MySQL, whose exec has no transaction to
 * offer, a writer that moves the row between them turns the insert into a
 * no-op, and that writer's own write then replaces what the purge left.
 *
 * The insert skips a row already present under the unique key. Only a writer of
 * the same source version can have put it there — two backfills of one row —
 * and that writer wrote the same text.
 */
const invertedWriteStatements = (dialect: SqlDialect, companion: string, id: string, counts: ReadonlyArray<[string, number]>, readAs: SourceRow): SQL[] => {
    const columns = sql.join(
        [FTS_TOKEN_COLUMN, FTS_ID_COLUMN, FTS_COUNT_COLUMN].map((column) => sql.identifier(column)),
        sql`, `,
    );
    const insert = (condition: SQL): SQL =>
        sql`INSERT INTO ${sql.identifier(companion)} (${columns}) SELECT ${qualified("j", "t")}, ${id}, ${qualified("j", "o")} FROM ${tokenRowsSource(dialect, counts)} WHERE ${condition}`;

    switch (dialect.name) {
        case "mysql": {
            const guard = unchangedSince(dialect, readAs);

            return [
                purgeStatement(companion, id, guard),
                sql`${insert(guard)} ON DUPLICATE KEY UPDATE ${qualified(companion, FTS_COUNT_COLUMN)} = ${qualified(companion, FTS_COUNT_COLUMN)}`,
            ];
        }
        case "postgres": {
            const source = sql.identifier("__source__");
            const purged = sql.identifier("__purged__");
            const current = sql`EXISTS (SELECT 1 FROM ${source})`;

            // The insert reads `__purged__`, so the purge runs to completion
            // before the first row goes in; left unread, it would run last.
            return [
                sql`WITH ${source} AS (${sourceRowStill(dialect, readAs)}), ${purged} AS (${purgeStatement(companion, id, current)} RETURNING 1) ${insert(sql`${current} AND (SELECT COUNT(*) FROM ${purged}) >= 0`)} ON CONFLICT DO NOTHING`,
            ];
        }
        default: {
            const guard = unchangedSince(dialect, readAs);

            return [purgeStatement(companion, id, guard), sql`${insert(guard)} ON CONFLICT DO NOTHING`];
        }
    }
};

/**
 * The predicate one query term matches a companion token with: an exact
 * equality, except for the query's final term, which matches as a prefix so a
 * search behaves as-you-type. Tokens are `[\p{L}\p{N}]+` by construction, so
 * the `LIKE` pattern carries no wildcard or escape character.
 *
 * `LIKE`, not the half-open range the vocabulary scorer uses, for the same
 * reason the chunk above is not 32: this layout runs only on Postgres and
 * MySQL, so Workerd's 50-byte LIKE cap cannot apply — and on Postgres a range
 * would be strictly worse. The companion's token btree declares
 * `text_pattern_ops` precisely so a prefix `LIKE` stays indexed under a
 * linguistic collation, and a `xxx_pattern_ops` class cannot answer `>=` / `<`
 * at all. A collation-ordered range is also a different set from a
 * character-wise `LIKE` (under `en_US.UTF-8`, `straße` falls inside the range
 * for `stras` but does not match `stras%`), which would put this backend's
 * results at odds with the FTS5 ones the shared scorer exists to keep aligned.
 */
const searchTermPredicate = (token: string, isLast: boolean): SQL =>
    isLast ? sql`${sql.identifier(FTS_TOKEN_COLUMN)} LIKE ${`${token}%`}` : sql`${sql.identifier(FTS_TOKEN_COLUMN)} = ${token}`;

/** The main-table (`m`) conditions every layout applies: the staged equality filters plus the soft-delete scope. */
const mainTableFilters = (definition: TableDefinitionLike, search: SearchStage): SQL[] => {
    const conditions = search.filters.map((filter) => sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);

    if (definition.softDeleteMode) {
        conditions.push(sql`m.${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

    return conditions;
};

/**
 * Join a `(id, __score__)` subquery back to the main table, apply the staged
 * filters, and return the decoded rows in shared-scorer order — the tail both
 * the inverted and FTS5 layouts share.
 */
const runScoredJoin = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number,
    scored: SQL,
): Promise<Record<string, unknown>[]> => {
    const conditions = mainTableFilters(definition, search);

    let query = sql`SELECT m.* FROM (${scored}) s JOIN ${sql.identifier(tableName)} m ON m.${sql.identifier("id")} = s.${sql.identifier(FTS_ID_COLUMN)}`;

    if (conditions.length > 0) {
        query = sql`${query} WHERE ${sql.join(conditions, sql` AND `)}`;
    }

    query = sql`${query} ORDER BY s.${sql.identifier("__score__")} DESC, m.${sql.identifier("_creationTime")} DESC, m.${sql.identifier("id")} ASC LIMIT ${sql.raw(String(limit))}`;

    return decodeRows(definition, await queryAll(exec, dialect, query));
};

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
 * the document, diverging from FTS5 and from `scoreTokens`.
 *
 * `SUM(occurrences)` is that scorer's term-frequency score computed in SQL, so
 * relevance order agrees with the FTS5 path, down to the `_creationTime DESC`
 * then `id` tiebreak.
 */
const runInvertedSearch = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query, createSearchAnalyzer(search.definition.language));

    if (tokens.length === 0) {
        return [];
    }

    const companion = ftsTableName(tableName, search.indexName);
    const lastIndex = tokens.length - 1;
    // Built once and reused by both clauses, so the "matched anything" filter
    // and the per-term "matched this one" tests cannot drift apart.
    const predicates = tokens.map((token, index) => searchTermPredicate(token, index === lastIndex));
    const anyTerm = sql.join(predicates, sql` OR `);
    // One `SUM(CASE …)` per term, for the match test *and* for the score.
    //
    // Summing the occurrence column once per row would count a companion row
    // once no matter how many terms it satisfies — but `scoreTokens` walks the
    // terms and counts the document's tokens afresh for each, so a token that
    // satisfies two terms contributes twice. `"javascript java"` against a
    // document holding `javascript` twice scores 4 there and would score 2 here.
    // The two engines would return the same documents in a different order,
    // which is exactly the divergence the shared scorer exists to prevent.
    const perTerm = predicates.map((predicate) => sql`SUM(CASE WHEN ${predicate} THEN ${sql.identifier(FTS_COUNT_COLUMN)} ELSE 0 END)`);
    const everyTerm = sql.join(
        perTerm.map((term) => sql`${term} > 0`),
        sql` AND `,
    );
    const scored = sql`SELECT ${sql.identifier(FTS_ID_COLUMN)}, ${sql.join(perTerm, sql` + `)} AS ${sql.identifier("__score__")} FROM ${sql.identifier(companion)} WHERE ${anyTerm} GROUP BY ${sql.identifier(FTS_ID_COLUMN)} HAVING ${everyTerm}`;

    return runScoredJoin(exec, dialect, definition, tableName, search, limit, scored);
};

/**
 * Run a search against the FTS5 shadow.
 *
 * The score is computed *in SQL*, from the index's own vocabulary view, rather
 * than by fetching a window and re-ranking it in memory. That distinction is
 * the whole point: FTS5 orders by bm25, which penalises document length and
 * common terms, and our contract orders by summed occurrences. The two are
 * unrelated, so a bm25-selected window is not the scorer's top-N — on a corpus
 * where more documents match than the window holds, the documents the contract
 * ranks highest can sit outside it entirely and never be considered. A
 * `.take(3)` then returned three arbitrary rows that claimed to be the best
 * three, and the two FTS5 backends did not even agree with each other.
 *
 * `fts5vocab(…, instance)` exposes one row per term instance, so a term's
 * frequency in a document is a `COUNT`. That makes the query the same shape the
 * portable layout uses — one `SUM(CASE …)` per term, added — and therefore the
 * same answer, by construction rather than by test. `LIMIT` is now exact, so an
 * unbounded read's over-cap probe row reaches the caller's cap check
 * instead of being clamped away.
 *
 * One branch per term rather than one `WHERE … OR …`: SQLite's planner silently
 * drops a range constraint that is OR'd with an equality on this module, which
 * returns *no* rows for the range half rather than an error.
 */
const runFtsSearch = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query, createSearchAnalyzer(search.definition.language));

    if (tokens.length === 0) {
        return [];
    }

    const companion = ftsTableName(tableName, search.indexName);
    const vocabulary = `${companion}__vocab`;
    const lastIndex = tokens.length - 1;
    const branches = tokens.map((token, index) => {
        const range = searchTermRange(token, index === lastIndex);
        const predicate = range.exact
            ? sql`${sql.identifier("term")} = ${range.lower}`
            : sql`${sql.identifier("term")} >= ${range.lower} AND ${sql.identifier("term")} < ${range.upper}`;

        return sql`SELECT ${sql.identifier("doc")}, ${sql.raw(String(index))} AS ${sql.identifier("__term__")}, COUNT(*) AS ${sql.identifier("__n__")} FROM ${sql.identifier(vocabulary)} WHERE ${predicate} GROUP BY ${sql.identifier("doc")}`;
    });
    const perTerm = tokens.map(
        (_, index) => sql`SUM(CASE WHEN u.${sql.identifier("__term__")} = ${sql.raw(String(index))} THEN u.${sql.identifier("__n__")} ELSE 0 END)`,
    );
    const scored = sql`SELECT f.${sql.identifier(FTS_ID_COLUMN)} AS ${sql.identifier(FTS_ID_COLUMN)}, ${sql.join(perTerm, sql` + `)} AS ${sql.identifier("__score__")} FROM (${unionAll(branches)}) u JOIN ${sql.identifier(companion)} f ON f.rowid = u.${sql.identifier("doc")} GROUP BY f.${sql.identifier(FTS_ID_COLUMN)} HAVING ${sql.join(
        perTerm.map((term) => sql`${term} > 0`),
        sql` AND `,
    )}`;

    return runScoredJoin(exec, dialect, definition, tableName, search, limit, scored);
};

/**
 * Run a search against the engine's own full-text index.
 *
 * Everything engine-specific — how the indexed form is matched and how a match
 * is ranked — comes from the dialect's statement builders, so this reader only
 * assembles the join, the filters and the bound. The builders qualify their
 * columns with the companion's real name rather than an alias, which is why the
 * companion is joined unaliased here.
 *
 * There is no re-rank pass: unlike the FTS5 path, the engine's own ranking is
 * the ordering we return, so the caller's `limit` bounds the read directly.
 */
const runNativeSearch = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    const native = dialect.nativeTextSearch;
    const tokens = tokenizeSearch(search.query, createSearchAnalyzer(search.definition.language));

    if (!native || tokens.length === 0) {
        return [];
    }

    const companion = ftsTableName(tableName, search.indexName);
    const conditions: SQL[] = [native.matches(companion, tokens), ...mainTableFilters(definition, search)];

    const statement = sql`SELECT m.* FROM ${sql.identifier(companion)} JOIN ${sql.identifier(tableName)} m ON m.${sql.identifier("id")} = ${sql.identifier(companion)}.${sql.identifier(FTS_ID_COLUMN)} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY ${native.rank(companion, tokens)} DESC, m.${sql.identifier("_creationTime")} DESC, m.${sql.identifier("id")} ASC LIMIT ${sql.raw(String(limit))}`;

    return decodeRows(definition, await queryAll(exec, dialect, statement));
};

/** The portable `(token, id, occurrences)` layout — every engine can serve it. */
const invertedLayout: SearchLayout = {
    ensureCompanion: async (exec, dialect, companion) => {
        const { integer, key } = dialect.companionTypes;

        await queryRun(
            exec,
            dialect,
            sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(companion)} (${sql.identifier(FTS_TOKEN_COLUMN)} ${sql.raw(key)} NOT NULL, ${sql.identifier(FTS_ID_COLUMN)} ${sql.raw(key)} NOT NULL, ${sql.identifier(FTS_COUNT_COLUMN)} ${sql.raw(integer)} NOT NULL)`,
        );

        // Every write purges its old rows by id first. The token index is the
        // unique key, which {@link migrateInvertedUniqueKey} adds once the
        // companion holds no duplicates.
        await createIndexIfNotExists(exec, dialect, {
            columns: invertedIndexColumn(dialect, FTS_ID_COLUMN, 191),
            name: `${companion}__by_id`,
            table: companion,
            unique: false,
        });
    },
    indexDocument: async (exec, dialect, companion, document, index, readAs) => {
        const counts = [...countSearchTokens(analyzedSearchText(document, index), createSearchAnalyzer(index.language))];

        await runInOrder(exec, dialect, invertedWriteStatements(dialect, companion, String(readAs.row["id"]), counts, readAs));
    },
    name: "inverted",
    purgeDocument: async (exec, dialect, companion, id, table) => {
        await queryRun(exec, dialect, purgeStatement(companion, id, absentFrom(table, id)));
    },
    runSearch: runInvertedSearch,
};

/**
 * The FTS5 shadow: one row of analyzed text per document, matched with `MATCH`,
 * reached through the `__ids` rowid map — see `fts-companion.ts` in
 * `@lunora/shard-engine`, which the Durable Object store shares. Every write is
 * an ordered statement list, run by {@link runInOrder}, and carries its guard in
 * every statement.
 */
const fts5Layout: SearchLayout = {
    ensureCompanion: async (exec, dialect, companion) => {
        await runInOrder(exec, dialect, ftsCompanionDdl(companion));
    },
    indexDocument: async (exec, dialect, companion, document, index, readAs) => {
        await runInOrder(
            exec,
            dialect,
            ftsWriteDocument(companion, String(readAs.row["id"]), analyzedSearchText(document, index), { guard: unchangedSince(dialect, readAs) }),
        );
    },
    name: "fts5",
    purgeDocument: async (exec, dialect, companion, id, table) => {
        await runInOrder(exec, dialect, ftsPurgeDocument(companion, id, { guard: absentFrom(table, id) }));
    },
    runSearch: runFtsSearch,
};

/**
 * The engine's own full-text index, opted into with `strategy: "native"`. Its
 * writes are not guarded: a write that lost a race here is repaired only by the
 * caller's re-check (`indexRowsUntilCurrent` in `ctx-db-search`).
 */
const nativeLayout: SearchLayout = {
    ensureCompanion: async (exec, dialect, companion) => {
        const native = dialect.nativeTextSearch;

        if (!native) {
            return;
        }

        await queryRun(exec, dialect, native.createCompanion(companion, dialect.companionTypes.key));

        for (const statement of native.createIndexes(companion)) {
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
            await queryRun(exec, dialect, statement);
        }
    },
    indexDocument: async (exec, dialect, companion, document, index, readAs) => {
        const native = dialect.nativeTextSearch;

        if (!native) {
            return;
        }

        const id = String(readAs.row["id"]);

        await queryRun(exec, dialect, purgeStatement(companion, id));
        await queryRun(exec, dialect, native.indexDocument(companion, id, analyzedSearchText(document, index)));
    },
    name: "native",
    purgeDocument: async (exec, dialect, companion, id) => {
        await queryRun(exec, dialect, purgeStatement(companion, id));
    },
    runSearch: runNativeSearch,
};

/**
 * Which layout an index uses. The single place the three-way decision is made —
 * `strategy: "native"` when the dialect can serve it, the FTS5 shadow when the
 * engine ships FTS5, the portable table otherwise.
 */
const resolveSearchLayout = (index: SearchIndexDefinitionLike, dialect: SqlDialect): SearchLayout => {
    if (index.strategy === "native" && dialect.nativeTextSearch !== undefined) {
        return nativeLayout;
    }

    return dialect.supportsFts5 ? fts5Layout : invertedLayout;
};

/**
 * The profile recorded for a companion: everything that changes what its rows
 * mean. The shared half — analysis and the indexed field — comes from
 * `searchIndexProfile`, so this backend cannot detect a rebuild the DO one
 * misses; the layout is appended because only this backend has more than one
 * physical shape, and a companion built for one holds different *columns* than
 * another.
 *
 * The layout is the LAST `/`-delimited segment, which is what `layoutOf` in
 * `ctx-db-search` reads back to tell an unsalvageable shape change from a
 * rebuild the existing rows can be walked through in place.
 */
const companionProfile = (index: SearchIndexDefinitionLike, dialect: SqlDialect): string =>
    `${searchIndexProfile(index)}/${resolveSearchLayout(index, dialect).name}`;

/**
 * Every table a `.global()` companion can be built for, paired with its index.
 *
 * Deliberately looser than `runSqlGlobalTableMigrations`, which provisions only
 * `kind === "global"`: a schema that declares no `shardMode` at all is admitted
 * here, mirroring the "probe every table" tolerance the read path keeps for
 * schemas that predate the flag. The cost is a companion created in the
 * `.global()` database for a table whose rows may live in the Durable Objects —
 * its source-table probe finds nothing, the backfill records itself complete,
 * and it is never touched again. Tightening it to match provisioning was tried
 * and reverted: `SchemaLike` callers legitimately omit `shardMode`, so the
 * strict filter silently stops indexing tables that do want a companion, which
 * is a far worse failure than an empty table.
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

/** The companion table backing one index. */
const companionFor = (tableName: string, index: SearchIndexDefinitionLike): string => ftsTableName(tableName, index.name);

/** One {@link migrateUnmappedEntries} pass over a page of unmapped rows. */
interface UnmappedPass {
    /** No unmapped rows past this page. */
    done: boolean;
    /** The highest rowid the page covered: where the next page starts. */
    last: number;
    /** Rows of this page still unmapped — each one lost its write to a concurrent one. */
    left: number;
}

/** FTS5 rows rewritten per migration pass — the bound on one cold start's share of it. */
const FTS_UNMAPPED_PAGE_ROWS = 100;

/** Ids per source-row lookup in {@link migrateUnmappedEntries}. */
const SOURCE_LOOKUP_IDS = 50;

/**
 * Rewrite one bounded page of the FTS5 rows the rowid map does not know about —
 * a previous build's, including any it wrote during the rollout — from the
 * source table, starting past rowid `after`, and report how the page went (see
 * {@link UnmappedPass}). Once none are left, a pass costs two reads: the source
 * table's existence probe and an empty rowid-range read. A no-op on the other
 * layouts.
 *
 * Rewriting from the source row, rather than adopting the stored text, is what
 * repairs a document indexed twice: which copy is stale cannot be told from the
 * companion, but the source row says what the entry should be. Each write is
 * guarded like the backfill's; one that loses to a concurrent write leaves its
 * rows in place, and the next pass rewrites them from the newer source row.
 */
const migrateUnmappedEntries = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
    after = 0,
): Promise<UnmappedPass> => {
    const nothing: UnmappedPass = { done: true, last: after, left: 0 };

    if (resolveSearchLayout(index, dialect) !== fts5Layout) {
        return nothing;
    }

    const source = await queryAll(exec, dialect, dialect.tableExists(tableName));

    if (source.length === 0) {
        return nothing;
    }

    const companion = companionFor(tableName, index);
    const unmapped = await queryAll(exec, dialect, ftsUnmappedPage(companion, FTS_UNMAPPED_PAGE_ROWS, after));

    if (unmapped.length === 0) {
        return nothing;
    }

    const last = Math.max(...unmapped.map((row) => Number(row["rowid"])));
    const byId = groupUnmappedRows(unmapped);
    const ids = [...byId.keys()];
    const sources = new Map<string, Record<string, unknown>>();

    // Bound parameters stay under the engine's 100 per statement.
    for (let start = 0; start < ids.length; start += SOURCE_LOOKUP_IDS) {
        const chunk = ids.slice(start, start + SOURCE_LOOKUP_IDS);
        // eslint-disable-next-line no-await-in-loop -- chunked lookups on the shared connection.
        const rows = await queryAll(
            exec,
            dialect,
            sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${qualified(tableName, "id")} IN (${sql.join(
                chunk.map((id) => sql`${id}`),
                sql`, `,
            )})`,
        );

        for (const row of rows) {
            // Keyed as text, like the page's ids: a mismatched key reads as "deleted".
            sources.set(String(row["id"]), row);
        }
    }

    const statements: SQL[] = [];

    for (const [id, unmappedRowids] of byId) {
        const row = sources.get(id);
        const document = row === undefined ? undefined : decodeRow(definition, row);
        // Absent from the source table: its entry goes, unless the row reappears first.
        const guard =
            row === undefined
                ? sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(tableName)} WHERE ${qualified(tableName, "id")} = ${id})`
                : unchangedSince(dialect, { row, table: tableName });
        statements.push(
            ...(document
                ? ftsWriteDocument(companion, id, analyzedSearchText(document, index), { guard, unmappedRowids })
                : ftsPurgeDocument(companion, id, { guard, unmappedRowids })),
        );
    }

    // The whole page in one batch: one D1 round trip, not one per document.
    // Each document's statements carry their own guard, so one losing to a
    // concurrent write leaves only its own rows in place.
    await runInOrder(exec, dialect, statements);

    // What lost to a concurrent write stays in the page's range.
    const left = await queryAll(
        exec,
        dialect,
        sql`SELECT COUNT(*) AS ${sql.identifier("n")} FROM ${sql.identifier(companion)} WHERE ${qualified(companion, "rowid")} > ${Math.max(0, after)} AND ${qualified(companion, "rowid")} <= ${last}`,
    );

    return { done: unmapped.length < FTS_UNMAPPED_PAGE_ROWS, last, left: Number(left[0]?.["n"] ?? 0) };
};

/** Documents checked per {@link migrateInvertedUniqueKey} pass — the bound on one cold start's share of it. */
const UNIQUE_KEY_PAGE_DOCUMENTS = 100;

/** The profile the unique-key walk records its progress under; nothing reads it back. */
const UNIQUE_KEY_PROFILE = "unique-key";

/** The search-state key {@link migrateInvertedUniqueKey} records its walk under. */
const invertedUniqueKeyState = (companion: string): string => `${companion}#unique`;

/**
 * How one {@link migrateInvertedUniqueKey} pass went: the key is in place, the
 * walk has more pages, or the walk reached the end but the key could not be
 * added and the walk starts over.
 */
type UniqueKeyPass = "done" | "more" | "restarted";

/**
 * Add the unique key, retrying once: the first attempt can fail because a
 * concurrent pass is creating the same index, and the second then finds it.
 * Returns `false` when the companion still holds a duplicate.
 */
const addUniqueKey = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<boolean> => {
    try {
        await createIndexIfNotExists(exec, dialect, invertedUniqueKey(dialect, companion));

        return true;
    } catch {
        // Retried below; a failure that is not a concurrent create fails again there.
    }

    try {
        await createIndexIfNotExists(exec, dialect, invertedUniqueKey(dialect, companion));

        return true;
    } catch (error) {
        if (dialect.isUniqueViolation(error)) {
            return false;
        }

        throw error;
    }
};

/** Drop the plain `(token, id)` index the unique key replaces. */
const dropLegacyTokenIndex = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<void> => {
    const legacy = sql.identifier(`${companion}__btree`);

    if (dialect.name !== "mysql") {
        await queryRun(exec, dialect, sql`DROP INDEX IF EXISTS ${legacy}`);

        return;
    }

    try {
        await queryRun(exec, dialect, sql`DROP INDEX ${legacy} ON ${sql.identifier(companion)}`);
    } catch (error) {
        // ER_CANT_DROP_FIELD_OR_KEY: already gone. MySQL has no `DROP INDEX IF EXISTS`.
        const missing = error as { code?: unknown; errno?: unknown };

        if (missing.errno !== 1091 && missing.code !== "ER_CANT_DROP_FIELD_OR_KEY") {
            throw error;
        }
    }
};

/**
 * Rewrite each of `ids` from its source row, which drops any duplicate rows it
 * holds. A document gone from the source table loses its rows. Each write is
 * guarded like the backfill's; one that loses to a concurrent write leaves its
 * duplicates for the unique-key attempt at the end of the walk to catch.
 */
const repairFromSource = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
    companion: string,
    ids: ReadonlyArray<string>,
): Promise<void> => {
    const probe = await queryAll(exec, dialect, dialect.tableExists(tableName));
    const sourceExists = probe.length > 0;
    const rows = sourceExists
        ? await queryAll(
              exec,
              dialect,
              sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${qualified(tableName, "id")} IN (${sql.join(
                  ids.map((id) => sql`${id}`),
                  sql`, `,
              )})`,
          )
        : [];
    const sources = new Map(rows.map((row) => [String(row["id"]), row]));

    for (const id of ids) {
        const row = sources.get(id);
        const document = row === undefined ? undefined : decodeRow(definition, row);

        if (row !== undefined && document) {
            // eslint-disable-next-line no-await-in-loop -- sequential companion writes on the shared connection.
            await invertedLayout.indexDocument(exec, dialect, companion, document, index, { row, table: tableName });

            continue;
        }

        // Absent: its rows go unless the row reappears first. Undecodable: the
        // backfill never indexes it either.
        let guard: SQL | undefined;

        if (row !== undefined) {
            guard = unchangedSince(dialect, { row, table: tableName });
        } else if (sourceExists) {
            guard = absentFrom(tableName, id);
        }

        // eslint-disable-next-line no-await-in-loop -- sequential companion writes on the shared connection.
        await queryRun(exec, dialect, purgeStatement(companion, id, guard));
    }
};

/**
 * Give an inverted companion its unique `(token, id)` key, one bounded page per
 * call; a no-op on the other layouts, and once the key is in place, one
 * primary-key read of the state table.
 *
 * A companion built before the key may hold a document's rows twice, and
 * Postgres and MySQL refuse to add a unique index while any duplicate exists.
 * So the pass first walks the companion's documents in id order,
 * {@link UNIQUE_KEY_PAGE_DOCUMENTS} at a time, from a cursor kept in the search
 * state table, and rewrites every document holding a duplicate from its source
 * row. One page reads the rows of that many documents, never the whole
 * companion. At the end of the walk it adds the key and drops the plain index
 * the key replaces.
 *
 * Two cold starts running it at once repeat each other's page, which is
 * harmless: the rewrites are guarded and idempotent. If the key still cannot be
 * added — a duplicate written behind the cursor while the walk ran — the cursor
 * goes back to the top and the next pass walks again.
 */
const migrateInvertedUniqueKey = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
): Promise<UniqueKeyPass> => {
    if (resolveSearchLayout(index, dialect) !== invertedLayout) {
        return "done";
    }

    const companion = companionFor(tableName, index);
    const key = invertedUniqueKeyState(companion);
    const state = await readSearchBackfillState(exec, dialect, key);

    if (state.done) {
        return "done";
    }

    const id = (alias: string): SQL => qualified(alias, FTS_ID_COLUMN);
    const page = await queryAll(
        exec,
        dialect,
        sql`SELECT ${id("c")} AS ${sql.identifier("id")}, COUNT(*) AS ${sql.identifier("n")}, COUNT(DISTINCT ${qualified("c", FTS_TOKEN_COLUMN)}) AS ${sql.identifier("d")} FROM ${sql.identifier(companion)} ${sql.identifier("c")} JOIN (SELECT DISTINCT ${id("q")} FROM ${sql.identifier(companion)} ${sql.identifier("q")} WHERE ${id("q")} > ${state.cursor ?? ""} ORDER BY ${id("q")} LIMIT ${sql.raw(String(UNIQUE_KEY_PAGE_DOCUMENTS))}) ${sql.identifier("p")} ON ${id("p")} = ${id("c")} GROUP BY ${id("c")} ORDER BY ${id("c")} ASC`,
    );
    const duplicated = page.filter((row) => Number(row["n"]) > Number(row["d"])).map((row) => String(row["id"]));

    if (duplicated.length > 0) {
        await repairFromSource(exec, dialect, definition, tableName, index, companion, duplicated);
    }

    if (page.length === UNIQUE_KEY_PAGE_DOCUMENTS) {
        await writeSearchBackfillState(exec, dialect, key, String(page.at(-1)?.["id"]), false, UNIQUE_KEY_PROFILE);

        return "more";
    }

    if (!(await addUniqueKey(exec, dialect, companion))) {
        await writeSearchBackfillState(exec, dialect, key, undefined, false, UNIQUE_KEY_PROFILE);

        return "restarted";
    }

    await dropLegacyTokenIndex(exec, dialect, companion);
    await writeSearchBackfillState(exec, dialect, key, undefined, true, UNIQUE_KEY_PROFILE);

    return "done";
};

export type { SearchLayout, SearchStage, SourceRow, UniqueKeyPass, UnmappedPass };
export {
    companionFor,
    companionProfile,
    fts5Layout,
    globalSearchIndexes,
    invertedLayout,
    invertedUniqueKeyState,
    migrateInvertedUniqueKey,
    migrateUnmappedEntries,
    nativeLayout,
    resolveSearchLayout,
    ROW_VERSION_COLUMNS,
};
