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
import { ftsCompanionDdl, ftsPurgeDocument, ftsWriteDocument, unionAll } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import type { MigrationMode, MigrationReport, MigrationTarget } from "./search-layout-migrations";
import { ensureInvertedUniqueKey, migrateFts5Companion, migrateInvertedCompanion } from "./search-layout-migrations";
import type { SourceRow } from "./search-writes";
import { absentFrom, invertedIndexColumn, invertedWriteStatements, purgeStatement, unchangedSince } from "./search-writes";
import type { SqlCtxExec } from "./sql-exec";
import { columnRefSql, createIndexIfNotExists, decodeRows, queryAll, queryRun, runInOrder, serializeColumnValue } from "./sql-exec";

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
     * Move a companion built by an earlier release to this layout's current
     * shape: a bounded `step` on every cold start, or all of it (`drain`) from
     * the backfill entry point. Absent when nothing ever changed.
     */
    migrate?: (exec: SqlCtxExec, dialect: SqlDialect, target: MigrationTarget, mode: MigrationMode) => Promise<MigrationReport>;

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

        // Every write finds a document's rows by id.
        await createIndexIfNotExists(exec, dialect, {
            columns: invertedIndexColumn(dialect, FTS_ID_COLUMN, 191),
            name: `${companion}__by_id`,
            table: companion,
            unique: false,
        });

        // The token index is the unique key: added here while the companion is
        // empty, and otherwise by `backfillSqlSearchIndexes`.
        await ensureInvertedUniqueKey(exec, dialect, companion);
    },
    indexDocument: async (exec, dialect, companion, document, index, readAs) => {
        const counts = [...countSearchTokens(analyzedSearchText(document, index), createSearchAnalyzer(index.language))];

        await runInOrder(exec, dialect, invertedWriteStatements(dialect, companion, String(readAs.row["id"]), counts, readAs));
    },
    migrate: migrateInvertedCompanion,
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
    migrate: migrateFts5Companion,
    name: "fts5",
    purgeDocument: async (exec, dialect, companion, id, table) => {
        await runInOrder(exec, dialect, ftsPurgeDocument(companion, id, { guard: absentFrom(table, id) }));
    },
    runSearch: runFtsSearch,
};

/**
 * The engine's own full-text index, opted into with `strategy: "native"`. Its
 * writes are not guarded: a write that lost a race here is repaired only by the
 * caller's re-check (`indexRowsUntilCurrent` in `ctx-db-search`), and a purge
 * after a delete is neither guarded nor re-checked, so one landing after a
 * re-insert of the same id drops the new document's entry until it is next
 * written.
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

export type { SearchLayout, SearchStage };
export { companionFor, companionProfile, fts5Layout, globalSearchIndexes, invertedLayout, nativeLayout, resolveSearchLayout };
