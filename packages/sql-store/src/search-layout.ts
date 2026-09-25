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

import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import {
    columnRefSql,
    createIndexIfNotExists,
    decodeRow,
    decodeRows,
    OCC_VERSION_COLUMN,
    queryAll,
    queryBatch,
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

    /** Replace one document's rows in the companion. */
    indexDocument: (
        exec: SqlCtxExec,
        dialect: SqlDialect,
        companion: string,
        id: string,
        document: Record<string, unknown>,
        index: SearchIndexDefinitionLike,
    ) => Promise<void>;

    /**
     * Identity of this layout, recorded with the companion's backfill progress.
     * A companion built for one layout holds different *columns* than another,
     * so a change here has to be detected and rebuilt rather than written into.
     */
    readonly name: "fts5" | "inverted" | "native";

    /** Delete every companion row for one document. */
    purgeDocument: (exec: SqlCtxExec, dialect: SqlDialect, companion: string, id: string) => Promise<void>;

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

/**
 * Delete every companion row for one document by its `__id__` column — the
 * first half of every write on the layouts whose `__id__` is indexed.
 */
const purgeDocument = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string, id: string): Promise<void> => {
    await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(companion)} WHERE ${sql.identifier(FTS_ID_COLUMN)} = ${id}`);
};

/**
 * One column of the portable companion's btree, rendered for the engine.
 *
 * Both columns use the dialect's `key` type, which on MySQL is `VARCHAR(768)` —
 * two of those exceed InnoDB's 3072-byte index limit, so they take the same
 * `(191)` key prefix the rank btree uses (a token is a single word; the prefix
 * never truncates one in practice). Postgres needs the opposite treatment: an
 * explicit `text_pattern_ops` class, or the prefix `LIKE` that resolves the
 * query's final term can't use the btree under a non-C collation.
 */
const invertedIndexColumn = (dialect: SqlDialect, column: string): SQL => {
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
 *
 * Deliberately NOT sized to Workerd's cap of 100, unlike its namesake in
 * `@lunora/shard-engine`: `chooseLayout` picks this layout only when the dialect
 * has no FTS5, and the only such dialects are Hyperdrive's Postgres and MySQL,
 * which bind thousands. D1's SQLite dialect sets `supportsFts5: true` and never
 * reaches here.
 */
const INSERT_CHUNK_ROWS = 50;

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

        // Not unique, so two cold-start backfills whose purge-then-insert pairs
        // interleave can double a document's rows — and nothing repairs that
        // until the document is written again. A unique index would turn the
        // same race into a failed request instead; fixing it properly needs a
        // per-dialect insert-or-ignore, and this layout only serves Hyperdrive.
        await createIndexIfNotExists(exec, dialect, {
            columns: sql`${invertedIndexColumn(dialect, FTS_TOKEN_COLUMN)}, ${invertedIndexColumn(dialect, FTS_ID_COLUMN)}`,
            name: `${companion}__btree`,
            table: companion,
            unique: false,
        });

        // Every row write purges its old rows by id first.
        await createIndexIfNotExists(exec, dialect, {
            columns: invertedIndexColumn(dialect, FTS_ID_COLUMN),
            name: `${companion}__by_id`,
            table: companion,
            unique: false,
        });
    },
    indexDocument: async (exec, dialect, companion, id, document, index) => {
        await purgeDocument(exec, dialect, companion, id);

        const rows = [...countSearchTokens(analyzedSearchText(document, index), createSearchAnalyzer(index.language))];
        const columns = sql.join(
            [FTS_TOKEN_COLUMN, FTS_ID_COLUMN, FTS_COUNT_COLUMN].map((column) => sql.identifier(column)),
            sql`, `,
        );
        const chunks: SQL[] = [];

        for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
            const values = sql.join(
                rows.slice(start, start + INSERT_CHUNK_ROWS).map(([token, occurrences]) => sql`(${token}, ${id}, ${occurrences})`),
                sql`, `,
            );

            chunks.push(sql`INSERT INTO ${sql.identifier(companion)} (${columns}) VALUES ${values}`);
        }

        // One round trip per document write when the exec exposes `batch`
        // (still chunked at INSERT_CHUNK_ROWS, so the bound-parameter count of
        // any one statement stays far under every engine's cap); a per-chunk
        // sequential `run()` loop otherwise.
        await queryBatch(exec, dialect, chunks);
    },
    name: "inverted",
    purgeDocument,
    runSearch: runInvertedSearch,
};

/** `<table>.<column>`, qualified so an unknown name errors instead of reading as a string. */
const qualified = (table: string, name: string): SQL => sql`${sql.identifier(table)}.${sql.identifier(name)}`;

/**
 * Whether the source row is still the one that was read, by
 * {@link ROW_VERSION_COLUMNS}. SQLite's `IS`, since only the FTS5 layout
 * evaluates it.
 */
const unchangedSince = ({ row, table }: SourceRow): SQL =>
    sql`EXISTS (SELECT 1 FROM ${sql.identifier(table)} WHERE ${qualified(table, "id")} = ${row["id"]}${sql.join(
        // eslint-disable-next-line unicorn/no-null -- SQL bind value: a NULL column compares with `IS NULL`
        ROW_VERSION_COLUMNS.map((column) => sql` AND ${qualified(table, column)} IS ${row[column] ?? null}`),
    )})`;

/**
 * The FTS5 shadow: one row of analyzed text per document, matched with `MATCH`,
 * reached through the `__ids` rowid map — see `fts-companion.ts` in
 * `@lunora/shard-engine`, which the Durable Object store shares. Every write is
 * an ordered statement list, run by {@link runInOrder}.
 */
const fts5Layout: SearchLayout = {
    ensureCompanion: async (exec, dialect, companion) => {
        await runInOrder(exec, dialect, ftsCompanionDdl(companion));
    },
    indexDocument: async (exec, dialect, companion, id, document, index) => {
        await runInOrder(exec, dialect, ftsWriteDocument(companion, id, analyzedSearchText(document, index)));
    },
    name: "fts5",
    purgeDocument: async (exec, dialect, companion, id) => {
        await runInOrder(exec, dialect, ftsPurgeDocument(companion, id));
    },
    runSearch: runFtsSearch,
};

/** The engine's own full-text index, opted into with `strategy: "native"`. */
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
    indexDocument: async (exec, dialect, companion, id, document, index) => {
        const native = dialect.nativeTextSearch;

        if (!native) {
            return;
        }

        await purgeDocument(exec, dialect, companion, id);
        await queryRun(exec, dialect, native.indexDocument(companion, id, analyzedSearchText(document, index)));
    },
    name: "native",
    purgeDocument,
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
 * Index a document the caller read some time ago — the backfill — so that the
 * write lands only if that source row is still current.
 *
 * On FTS5 the check runs inside the write's own statements, so no concurrent
 * writer can land between the check and the write, and a fresher entry is never
 * replaced — not even for the moment until the caller's re-check catches it.
 * The other layouts write regardless and rely on that re-check alone.
 */
const indexDocumentAsRead = async (
    layout: SearchLayout,
    exec: SqlCtxExec,
    dialect: SqlDialect,
    companion: string,
    document: Record<string, unknown>,
    index: SearchIndexDefinitionLike,
    readAs: SourceRow,
): Promise<void> => {
    const id = String(readAs.row["id"]);

    if (layout !== fts5Layout) {
        await layout.indexDocument(exec, dialect, companion, id, document, index);

        return;
    }

    await runInOrder(exec, dialect, ftsWriteDocument(companion, id, analyzedSearchText(document, index), { guard: unchangedSince(readAs) }));
};

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
                : unchangedSince({ row, table: tableName });
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

export type { SearchLayout, SearchStage, SourceRow, UnmappedPass };
export {
    companionFor,
    companionProfile,
    fts5Layout,
    globalSearchIndexes,
    indexDocumentAsRead,
    invertedLayout,
    migrateUnmappedEntries,
    nativeLayout,
    resolveSearchLayout,
    ROW_VERSION_COLUMNS,
};
