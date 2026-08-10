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

/**
 * Workerd hard-sets `SQLITE_LIMIT_COMPOUND_SELECT` to 5 (stock SQLite defaults
 * to 500), and D1 runs the same build — so on the two engines this repo ships
 * against, a flat `a UNION ALL b UNION ALL …` over more than five branches is a
 * runtime error, not a slow query.
 * @see https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B
 */
const COMPOUND_SELECT_LIMIT = 5;

/**
 * Longest value list still rendered as a literal `IN (?, ?, …)`.
 *
 * Workerd caps `SQLITE_LIMIT_VARIABLE_NUMBER` at 100 and D1 documents the same
 * ceiling ("maximum bound parameters per query: 100"), so a placeholder per item
 * fails outright on a large set — and the relation semijoin deliberately pulls
 * back up to 5,000 join keys. Half the budget is spent here at most; the rest of
 * the statement (the other predicates, the cursor, the limit) keeps the other
 * half.
 */
const IN_LIST_PARAM_BUDGET = 50;

/**
 * Values that survive a `JSON.stringify` round-trip intact, so the `json_each`
 * form is safe for them. Non-finite numbers do not: `JSON.stringify` writes
 * `NaN` and `±Infinity` as `null`, which would silently change what the list
 * matches — those keep the literal form.
 */
const isJsonSafe = (value: unknown): boolean =>
    value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

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

/**
 * Join `branches` with `UNION ALL`, nesting so no single compound exceeds
 * {@link COMPOUND_SELECT_LIMIT} terms.
 *
 * A sub-select restarts the parser's term counter, so five-at-a-time grouping
 * wrapped in `SELECT * FROM (…)` yields the same rows in the same order from
 * one round-trip at any branch count — where a flat join fails with
 * `too many terms in compound SELECT: SQLITE_ERROR` past five. Below the limit
 * nothing is wrapped, so the common narrow case renders exactly as before.
 *
 * The derived tables are aliased because MySQL and Postgres require it; SQLite
 * accepts the alias either way.
 * @param branches one or more single-`SELECT` fragments, each with the same result columns
 */
export const unionAll = (branches: ReadonlyArray<SQL>): SQL => {
    if (branches.length === 0) {
        throw new Error("unionAll: expected at least one branch");
    }

    let level: SQL[] = [...branches];

    while (level.length > COMPOUND_SELECT_LIMIT) {
        const nested: SQL[] = [];

        for (let start = 0; start < level.length; start += COMPOUND_SELECT_LIMIT) {
            const group = sql.join(level.slice(start, start + COMPOUND_SELECT_LIMIT), sql` UNION ALL `);

            nested.push(sql`SELECT * FROM (${group}) ${sql.identifier("__u__")}`);
        }

        level = nested;
    }

    return sql.join(level, sql` UNION ALL `);
};

/**
 * Render `reference [NOT] IN (…)` over `items` for SQLite (Durable Objects and
 * D1), binding a long list as **one** JSON parameter rather than one placeholder
 * per item.
 *
 * `x IN (SELECT value FROM json_each(?))` is the same set membership as a
 * literal list, but its placeholder count is 1 regardless of set size — which is
 * what keeps a wide `in` / semijoin under {@link IN_LIST_PARAM_BUDGET}. Short
 * lists keep the literal form: it plans against an index better, and it is what
 * every existing emitted-SQL assertion expects.
 *
 * A list holding anything JSON cannot carry losslessly (bigint, bytes, Date)
 * stays literal — correctness first; those sets are small in practice.
 * @param reference the column or expression tested for membership
 * @param items already serialized to their bound storage form
 * @param negated `true` renders `NOT IN`
 * @param budget how many placeholders this list may spend; lower it when the same list is repeated across several branches of one statement
 */
export const sqliteInList = (reference: SQL, items: ReadonlyArray<unknown>, negated: boolean, budget = IN_LIST_PARAM_BUDGET): SQL => {
    const keyword = negated ? sql` NOT IN ` : sql` IN `;

    if (items.length <= budget || !items.every((item) => isJsonSafe(item))) {
        return sql`${reference}${keyword}(${sql.join(
            items.map((item) => param(item)),
            sql`, `,
        )})`;
    }

    return sql`${reference}${keyword}(SELECT ${sql.identifier("value")} FROM json_each(${JSON.stringify(items)}))`;
};
