/**
 * The guarded statements every search companion write is built from: the
 * source-row guards, the source-row lookup, and the portable inverted layout's
 * write and unique key.
 *
 * Shared by the layouts (`search-layout.ts`) and their migrations
 * (`search-layout-migrations.ts`), which is why it is a module of its own: the
 * layouts run the migrations, so the migrations cannot import the layouts.
 */

/* eslint-disable no-restricted-syntax -- `sql`…`` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */
/* eslint-disable unicorn/prevent-abbreviations -- `SqlCtxExec` is this package's established exec type name. */

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { FTS_COUNT_COLUMN, FTS_ID_COLUMN, FTS_TOKEN_COLUMN } from "@lunora/search-core";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { nullSafeEqualsSql, OCC_VERSION_COLUMN, queryAll } from "./sql-exec";

/** A source-table row exactly as it was read, with the table it was read from. */
interface SourceRow {
    row: Record<string, unknown>;
    table: string;
}

/**
 * The columns that say whether a source row changed since it was read: every
 * guarded write bumps `_version`, and `_creationTime` tells a delete-and-reinsert
 * under the same id apart, whose version restarts at NULL. Read by both the SQL
 * guard ({@link unchangedSince}) and the re-check in `ctx-db-search`.
 */
const ROW_VERSION_COLUMNS: ReadonlyArray<string> = [OCC_VERSION_COLUMN, "_creationTime"];

/** Ids per source-row lookup: bound parameters stay under the engine's 100 per statement. */
const SOURCE_LOOKUP_IDS = 50;

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
 *
 * The lock is not free. It holds the source row for the length of one companion
 * statement, so a writer of that row waits that long, and on a row several
 * writers hit at once, overlapping share locks are recorded as a multixact —
 * extra bookkeeping Postgres pays on every such lock and vacuums later.
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
 * The guard for rewriting document `id` from its source row as just read: the
 * row is still that version, or, when it was absent, it is still absent.
 */
const guardFor = (dialect: SqlDialect, table: string, id: string, row: Record<string, unknown> | undefined): SQL =>
    row === undefined ? absentFrom(table, id) : unchangedSince(dialect, { row, table });

/**
 * The source rows of `ids`, keyed by id as text, which is how the companions
 * hold them. An id missing from the result has no row.
 */
const readSourceRows = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    table: string,
    ids: ReadonlyArray<string>,
): Promise<Map<string, Record<string, unknown>>> => {
    const sources = new Map<string, Record<string, unknown>>();

    for (let start = 0; start < ids.length; start += SOURCE_LOOKUP_IDS) {
        const chunk = ids.slice(start, start + SOURCE_LOOKUP_IDS);
        // eslint-disable-next-line no-await-in-loop -- chunked lookups on the shared connection.
        const rows = await queryAll(
            exec,
            dialect,
            sql`SELECT * FROM ${sql.identifier(table)} WHERE ${qualified(table, "id")} IN (${sql.join(
                chunk.map((id) => sql`${id}`),
                sql`, `,
            )})`,
        );

        for (const row of rows) {
            sources.set(String(row["id"]), row);
        }
    }

    return sources;
};

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

/** Characters of a document id the MySQL unique key covers. */
const MYSQL_KEY_ID_PREFIX = 512;

/**
 * The unique key of the portable companion: one row per `(token, document)`.
 * It replaces the plain `__btree` index the layout had before and serves the
 * same token lookups.
 *
 * On MySQL the token takes a 256-character prefix, which is the analyzer's
 * `MAX_TOKEN_LENGTH`, so uniqueness is exact per token, and the id takes the
 * rest of InnoDB's 3072 bytes: {@link MYSQL_KEY_ID_PREFIX} characters under
 * utf8mb4. Two ids that agree on those characters and share a token cannot both
 * be keyed, so the key is not added while they exist, and the backfill reports
 * it missing and names the cause (`search-layout-migrations.ts`).
 */
const invertedUniqueKey = (dialect: SqlDialect, companion: string): { columns: SQL; concurrently: boolean; name: string; table: string; unique: boolean } => {
    return {
        columns: sql`${invertedIndexColumn(dialect, FTS_TOKEN_COLUMN, 256)}, ${invertedIndexColumn(dialect, FTS_ID_COLUMN, MYSQL_KEY_ID_PREFIX)}`,
        concurrently: true,
        name: `${companion}__unique`,
        table: companion,
        unique: true,
    };
};

/**
 * A bound token as MySQL compares it with a stored one: byte for byte, as the
 * companion's own columns do. Explicit, so the comparison also holds on a
 * companion created before the dialect pinned that collation, where two
 * different implicit collations would refuse to compare.
 */
const mysqlToken = (reference: SQL): SQL => sql`${reference} COLLATE utf8mb4_0900_bin`;

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
            // SQLite never uses this layout in production (D1 has FTS5); this branch exists for the node:sqlite tests.
            return sql`(SELECT json_extract(${qualified("e", "value")}, '$.t') AS ${sql.identifier("t")}, json_extract(${qualified("e", "value")}, '$.o') AS ${sql.identifier("o")} FROM json_each(${json}) AS ${sql.identifier("e")}) AS ${sql.identifier("j")}`;
        }
    }
};

/**
 * The statements that replace one document's rows in the portable companion,
 * landing only while the source row is still `readAs`.
 *
 * - **Postgres:** ONE statement — the purge a data-modifying CTE, the insert
 *   waiting on it — so a reader never sees the document half-written, and the
 *   share lock {@link sourceRowStill} takes covers both halves. The insert skips
 *   a row already present under the unique key: only a writer of the same source
 *   version can have put it there, and it wrote the same text.
 * - **MySQL:** the Hyperdrive exec runs one statement at a time over a
 *   connection it may share, so there is no transaction to pin, and the write is
 *   three guarded statements that each leave a superset of the right rows: add
 *   the tokens the document lacks, set the counts of the ones it has, then drop
 *   the ones it no longer has. A writer that moves the row between them turns
 *   the rest into no-ops and leaves old and new tokens side by side, never none —
 *   that writer's own write, or the caller's re-check, then prunes them. Adding
 *   only the missing tokens also keeps a companion without the unique key free
 *   of duplicates.
 * - **SQLite:** a purge and an insert in one batch, which D1 runs as one
 *   transaction. This layout never runs on D1; the branch exists for the
 *   node:sqlite tests.
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
            const token = qualified(companion, FTS_TOKEN_COLUMN);
            const held = sql.identifier("held");

            return [
                sql`${insert(sql`${guard} AND NOT EXISTS (SELECT 1 FROM ${sql.identifier(companion)} AS ${held} WHERE ${qualified("held", FTS_ID_COLUMN)} = ${id} AND ${qualified("held", FTS_TOKEN_COLUMN)} = ${mysqlToken(qualified("j", "t"))})`)} ON DUPLICATE KEY UPDATE ${qualified(companion, FTS_COUNT_COLUMN)} = ${qualified(companion, FTS_COUNT_COLUMN)}`,
                sql`UPDATE ${sql.identifier(companion)} JOIN ${tokenRowsSource(dialect, counts)} ON ${token} = ${mysqlToken(qualified("j", "t"))} SET ${qualified(companion, FTS_COUNT_COLUMN)} = ${qualified("j", "o")} WHERE ${qualified(companion, FTS_ID_COLUMN)} = ${id} AND ${guard}`,
                sql`DELETE FROM ${sql.identifier(companion)} WHERE ${qualified(companion, FTS_ID_COLUMN)} = ${id} AND ${guard} AND ${token} NOT IN (SELECT ${mysqlToken(qualified("j", "t"))} FROM ${tokenRowsSource(dialect, counts)})`,
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

export type { SourceRow };
export {
    absentFrom,
    guardFor,
    invertedIndexColumn,
    invertedUniqueKey,
    invertedWriteStatements,
    MYSQL_KEY_ID_PREFIX,
    purgeStatement,
    qualified,
    readSourceRows,
    ROW_VERSION_COLUMNS,
    unchangedSince,
};
