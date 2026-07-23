/**
 * Drizzle render layer — the foundation both ORM cores (`@lunora/sql-store`'s
 * global store and `@lunora/do`'s JSON-blob store) build on.
 *
 * Each core builds composable {@link SQL} objects (via the `sql` template tag and
 * the `compileWhereSql` compiler) and renders them to `{ sql, params }`
 * here, per engine. Drizzle's dialects own the two things the old core hand-paid
 * for: identifier quoting (`"…"` on SQLite/Postgres, `` `…` `` on MySQL) and
 * placeholder style (`?` on SQLite/MySQL, `$1,$2,…` on Postgres). That deletes
 * the bespoke `quoteIdentifier` plus the `?`→`$N` / `"…"`→backtick exec rewrites.
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const PG_DIALECT = new PgDialect();
const MYSQL_DIALECT = new MySqlDialect();
const SQLITE_DIALECT = new SQLiteSyncDialect();

const DIALECTS = { mysql: MYSQL_DIALECT, postgres: PG_DIALECT, sqlite: SQLITE_DIALECT } as const;

/** The SQL engine a render targets. */
export type SqlEngine = "mysql" | "postgres" | "sqlite";

/** A rendered statement: the engine-specific SQL text and its positional bound parameters. */
export interface RenderedSql {
    params: unknown[];
    sql: string;
}

/**
 * Render a composable drizzle {@link SQL} to `{ sql, params }` for `engine` —
 * identifiers quoted and placeholders numbered the way that engine expects.
 */
export const renderSql = (engine: SqlEngine, query: SQL): RenderedSql => {
    const { params, sql: text } = DIALECTS[engine].sqlToQuery(query);

    return { params, sql: text };
};

/**
 * A bound-parameter drizzle chunk for one value — the building block for
 * `VALUES (…)` / `IN (…)` lists assembled via `sql.join`. Shared by both ctx-db
 * cores so the single-interpolation helper (and its lint exemption) lives once.
 */
// eslint-disable-next-line no-restricted-syntax, unicorn/prevent-abbreviations -- drizzle param chunk: the single-interpolation tagged template binds the value (not a string conversion); `param` matches the established name in both ctx-db cores.
export const param = (value: unknown): SQL => sql`${value}`;
