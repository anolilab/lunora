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
import { LunoraError } from "@lunora/errors";
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
 * The limits Workerd's SQLite build sets far below stock SQLite's, and the
 * single source every derived chunk size and budget in this package reads.
 *
 * These are platform facts, not tuning knobs: over any of them the statement
 * fails to prepare with `SQLITE_ERROR` rather than merely running slower. D1
 * runs the same build, so they bind on both engines this repo ships against.
 *
 * Written down once because they were previously re-derived by hand in five
 * places — a `Math.floor(100 / 3)` here, a literal `50` there — with nothing
 * tying them back to the limit they came from.
 * @see https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B
 */
const WORKERD_SQLITE_LIMITS = {
    /** `SQLITE_LIMIT_VARIABLE_NUMBER` — bound parameters per statement. Stock SQLite allows 500,000; D1 documents the same 100. */
    boundParams: 100,
    /** `SQLITE_LIMIT_COMPOUND_SELECT` — terms in one `UNION ALL` chain. Stock SQLite allows 500. */
    compoundSelect: 5,
    /** `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` — bytes in a `LIKE`/`GLOB` pattern. Stock SQLite allows 50,000. */
    likePattern: 50,
    /** `SQLITE_LIMIT_SQL_LENGTH` — BYTES of statement text, not characters. Stock SQLite allows 1 GB. */
    sqlTextLength: 100_000,
} as const;

/**
 * Longest value list still rendered as a literal `IN (?, ?, …)`.
 *
 * Half the statement's parameter budget at most, so the rest of it (the other
 * predicates, the cursor, the limit) keeps the other half — and the relation
 * semijoin, which deliberately pulls back up to 5,000 join keys, is nowhere
 * near either half.
 */
const IN_LIST_PARAM_BUDGET = WORKERD_SQLITE_LIMITS.boundParams / 2;

/**
 * Values that survive a `JSON.stringify` → SQLite `json_each` round-trip
 * unchanged, so the JSON list form matches exactly what a literal list would.
 *
 * Two kinds do not, and both fail silently rather than loudly, which is why
 * they are excluded by value rather than by type. Non-finite numbers:
 * `JSON.stringify` writes `NaN` and `±Infinity` as `null`, so the list would
 * stop matching them and start matching null. Lone surrogates: `JSON.stringify`
 * escapes them as `\udXXX` and SQLite's JSON parser folds that to U+FFFD, so the
 * same list matches different rows either side of the budget — well-formed text
 * has none, and `isWellFormed()` is the exact test.
 *
 * `Uint8Array` (the only non-primitive that reaches here — the DO's
 * `serializeSqlValue` yields `null | number | string`, and sql-store's
 * `sqliteEncode` turns bigint into a decimal string and Date into a JSON one)
 * has no JSON form at all.
 */
const isJsonSafe = (value: unknown): boolean => {
    if (value === null || typeof value === "boolean") {
        return true;
    }

    if (typeof value === "number") {
        return Number.isFinite(value);
    }

    return typeof value === "string" && value.isWellFormed();
};

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
 * the engine's compound-SELECT limit.
 *
 * A sub-select restarts the parser's term counter, so five-at-a-time grouping
 * wrapped in `SELECT * FROM (…)` yields the same rows from one round-trip at
 * any branch count — where a flat join fails with
 * `too many terms in compound SELECT: SQLITE_ERROR` past five. Below the limit
 * nothing is wrapped, so the common narrow case renders exactly as before.
 *
 * Row *order* is unspecified either way — `UNION ALL` promises none — so a
 * caller that needs one must impose it (an `ORDER BY`, a `GROUP BY`, or a
 * `LIMIT 1` over branches at most one of which can match).
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

    while (level.length > WORKERD_SQLITE_LIMITS.compoundSelect) {
        const nested: SQL[] = [];

        for (let start = 0; start < level.length; start += WORKERD_SQLITE_LIMITS.compoundSelect) {
            const group = sql.join(level.slice(start, start + WORKERD_SQLITE_LIMITS.compoundSelect), sql` UNION ALL `);

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
 * A list JSON cannot carry losslessly (see {@link isJsonSafe}) has no bounded
 * form, so an over-budget one throws rather than emitting a statement that is
 * certain to fail to prepare. In practice that is a `Uint8Array` set on the
 * sql-store path; the alternative — falling back to a placeholder per item —
 * trades a clear error for `SQLITE_ERROR: too many SQL variables`.
 * @param reference the column or expression tested for membership
 * @param items already serialized to their bound storage form
 * @param negated `true` renders `NOT IN`
 * @param budget how many placeholders this list may spend; lower it when the same list is repeated across several branches of one statement, or when one statement carries several lists
 */
export const sqliteInList = (reference: SQL, items: ReadonlyArray<unknown>, negated: boolean, budget = IN_LIST_PARAM_BUDGET): SQL => {
    const keyword = negated ? sql` NOT IN ` : sql` IN `;
    const jsonSafe = items.every((item) => isJsonSafe(item));

    if (items.length > budget && !jsonSafe) {
        throw new LunoraError(
            "BAD_REQUEST",
            `an "in" list of ${String(items.length)} values holds a value JSON cannot carry (bytes, a non-finite number, or malformed text), so it cannot be bound as one parameter — and ${String(items.length)} placeholders exceed SQLite's per-statement cap of 100 on Durable Objects and D1. Narrow the list to ${String(budget)} values or fewer.`,
        );
    }

    if (items.length <= budget) {
        return sql`${reference}${keyword}(${sql.join(
            items.map((item) => param(item)),
            sql`, `,
        )})`;
    }

    return sql`${reference}${keyword}(SELECT ${sql.identifier("value")} FROM json_each(${JSON.stringify(items)}))`;
};

export { isJsonSafe, WORKERD_SQLITE_LIMITS };
