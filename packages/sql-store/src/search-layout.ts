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

import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/do";
import {
    analyzedSearchText,
    buildFtsMatch,
    countSearchTokens,
    createSearchAnalyzer,
    FTS_COUNT_COLUMN,
    FTS_ID_COLUMN,
    FTS_TEXT_COLUMN,
    FTS_TOKEN_COLUMN,
    ftsTableName,
    MAX_SEARCH_SCAN,
    scoreDocument,
    tokenizeSearch,
} from "@lunora/do";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { columnRefSql, decodeRows, queryAll, queryRun, serializeColumnValue } from "./sql-exec";

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

/** Delete every companion row for one document — the first half of every write. */
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
 */
const INSERT_CHUNK_ROWS = 50;

/**
 * Create an index on a companion idempotently across engines. SQLite/Postgres
 * support `CREATE INDEX IF NOT EXISTS`; MySQL does not, so it creates
 * unconditionally and swallows the duplicate-key-name error a re-run raises.
 */
const createCompanionIndex = async (exec: SqlCtxExec, dialect: SqlDialect, spec: { columns: SQL; name: string; table: string }): Promise<void> => {
    if (dialect.name === "mysql") {
        try {
            await queryRun(exec, dialect, sql`CREATE INDEX ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
        } catch (error) {
            // ER_DUP_KEYNAME. Drivers disagree on which field carries it —
            // mysql2 sets `errno`, others only the symbolic `code`.
            const duplicate = error as { code?: unknown; errno?: unknown };

            if (duplicate.errno !== 1061 && duplicate.code !== "ER_DUP_KEYNAME" && duplicate.code !== 1061) {
                throw error;
            }
        }

        return;
    }

    await queryRun(exec, dialect, sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
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
    const everyTerm = sql.join(
        predicates.map((predicate) => sql`SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END) > 0`),
        sql` AND `,
    );
    const scored = sql`SELECT ${sql.identifier(FTS_ID_COLUMN)}, SUM(${sql.identifier(FTS_COUNT_COLUMN)}) AS ${sql.identifier("__score__")} FROM ${sql.identifier(companion)} WHERE ${anyTerm} GROUP BY ${sql.identifier(FTS_ID_COLUMN)} HAVING ${everyTerm}`;

    const conditions: SQL[] = [];

    for (const filter of search.filters) {
        conditions.push(sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);
    }

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

    const ftName = ftsTableName(tableName, search.indexName);
    // MATCH must target the FTS table (by name or an indexed column), never the
    // bare alias `f` — `f MATCH ?` is a "no such column: f" error in SQLite.
    // We match the indexed `__text__` column so the alias join still works.
    const conditions: SQL[] = [sql`f.${sql.identifier(FTS_TEXT_COLUMN)} MATCH ${buildFtsMatch(tokens)}`];

    for (const filter of search.filters) {
        conditions.push(sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);
    }

    if (definition.softDeleteMode) {
        conditions.push(sql`m.${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

    // The window is the scan cap, NOT the caller's limit — this is the subtle
    // part. bm25 decides which rows we fetch and `scoreDocument` decides how
    // they are ordered, so fetching only `limit` rows would let bm25 pick a
    // different subset than our scorer's true top-N: a `.take(2)` and the first
    // page of a `.paginate({ numItems: 2 })` would disagree with the portable
    // layout even though a `.collect()` agrees. Fetch the whole capped window,
    // re-rank it, and slice at the end.
    const query = sql`SELECT m.*, f.${sql.identifier(FTS_TEXT_COLUMN)} FROM ${sql.identifier(ftName)} f JOIN ${sql.identifier(tableName)} m ON m.${sql.identifier("id")} = f.${sql.identifier(FTS_ID_COLUMN)} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY f.rank LIMIT ${sql.raw(String(MAX_SEARCH_SCAN))}`;

    const analyzer = createSearchAnalyzer(search.definition.language);
    const rows = await queryAll(exec, dialect, query);
    const scored: { creationTime: number; doc: Record<string, unknown>; id: string; score: number }[] = [];

    for (const row of rows) {
        const [document] = decodeRows(definition, [row]);

        if (!document) {
            continue;
        }

        const indexed = row[FTS_TEXT_COLUMN];

        scored.push({
            creationTime: typeof document["_creationTime"] === "number" ? document["_creationTime"] : 0,
            doc: document,
            id: typeof document["_id"] === "string" ? document["_id"] : "",
            score: scoreDocument(typeof indexed === "string" ? indexed : "", tokens, analyzer),
        });
    }

    scored.sort((a, b) => b.score - a.score || b.creationTime - a.creationTime || a.id.localeCompare(b.id));

    return scored.slice(0, limit).map((entry) => entry.doc);
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
    const conditions: SQL[] = [native.matches(companion, tokens)];

    for (const filter of search.filters) {
        conditions.push(sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);
    }

    if (definition.softDeleteMode) {
        conditions.push(sql`m.${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

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

        // Not unique: a concurrent cold-start backfill could briefly double a
        // row, which the delete-then-insert write repairs, whereas a unique
        // violation would fail the request outright.
        await createCompanionIndex(exec, dialect, {
            columns: sql`${invertedIndexColumn(dialect, FTS_TOKEN_COLUMN)}, ${invertedIndexColumn(dialect, FTS_ID_COLUMN)}`,
            name: `${companion}__btree`,
            table: companion,
        });

        // Every row write purges its old rows by id first.
        await createCompanionIndex(exec, dialect, {
            columns: invertedIndexColumn(dialect, FTS_ID_COLUMN),
            name: `${companion}__by_id`,
            table: companion,
        });
    },
    indexDocument: async (exec, dialect, companion, id, document, index) => {
        await purgeDocument(exec, dialect, companion, id);

        const rows = [...countSearchTokens(analyzedSearchText(document, index), createSearchAnalyzer(index.language))];
        const columns = sql.join(
            [FTS_TOKEN_COLUMN, FTS_ID_COLUMN, FTS_COUNT_COLUMN].map((column) => sql.identifier(column)),
            sql`, `,
        );

        for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
            const values = sql.join(
                rows.slice(start, start + INSERT_CHUNK_ROWS).map(([token, occurrences]) => sql`(${token}, ${id}, ${occurrences})`),
                sql`, `,
            );

            // eslint-disable-next-line no-await-in-loop -- companion writes run sequentially on the single shared connection, like every other write path here.
            await queryRun(exec, dialect, sql`INSERT INTO ${sql.identifier(companion)} (${columns}) VALUES ${values}`);
        }
    },
    name: "inverted",
    runSearch: runInvertedSearch,
};

/** The FTS5 shadow: one row of analyzed text per document, matched with `MATCH`. */
const fts5Layout: SearchLayout = {
    ensureCompanion: async (exec, dialect, companion) => {
        await queryRun(
            exec,
            dialect,
            sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(companion)} USING fts5(${sql.identifier("__text__")}, ${sql.identifier(FTS_ID_COLUMN)} UNINDEXED)`,
        );
    },
    indexDocument: async (exec, dialect, companion, id, document, index) => {
        await purgeDocument(exec, dialect, companion, id);
        await queryRun(
            exec,
            dialect,
            sql`INSERT INTO ${sql.identifier(companion)} (${sql.identifier("__text__")}, ${sql.identifier(FTS_ID_COLUMN)}) VALUES (${analyzedSearchText(document, index)}, ${id})`,
        );
    },
    name: "fts5",
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
 * The profile recorded for a companion: its analysis *and* its layout. Both
 * change what the stored rows mean, so both have to be detected.
 */
const companionProfile = (index: SearchIndexDefinitionLike, dialect: SqlDialect): string =>
    `${createSearchAnalyzer(index.language).profile}/${resolveSearchLayout(index, dialect).name}`;

/**
 * Every table a `.global()` companion can be built for, paired with its index.
 * A `.shardBy()` table's rows live in the DOs, so a companion over one could
 * never be populated; schemas authored before the `.global()` flag existed
 * don't set `shardMode` at all and still get theirs.
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

export type { SearchLayout, SearchStage };
export { companionFor, companionProfile, fts5Layout, globalSearchIndexes, invertedLayout, nativeLayout, purgeDocument, resolveSearchLayout };
