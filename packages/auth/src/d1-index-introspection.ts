/**
 * A D1 compatibility shim for better-auth's schema-diff step.
 *
 * better-auth 1.7 added `getDatabaseIndexes()` to `getMigrations()`. Its SQLite
 * branch joins `sqlite_master` against the table-valued `pragma_index_list()` /
 * `pragma_index_info()` functions:
 *
 * ```sql
 * FROM sqlite_master AS tables
 * INNER JOIN pragma_index_list(tables.name) AS index_list
 * INNER JOIN pragma_index_info(index_list.name) AS index_info
 * ```
 *
 * Cloudflare D1's authorizer refuses any pragma table-valued function through the
 * Worker binding — with a bound parameter *or* an inline literal — so the whole
 * migration throws `not authorized: SQLITE_AUTH` before a single table is created,
 * and the first sign-up then fails with `no such table: user`. (`wrangler d1
 * execute` is more permissive than the binding, so this never reproduces from the
 * CLI, which makes it an easy afternoon to lose.)
 *
 * This is an upstream bug — D1 is a first-party better-auth target, and its own
 * D1 dialect introspects columns the D1-safe way — reported as
 * better-auth/better-auth#10551. It still has to be worked around here, or no
 * Lunora app can boot `.auth()` against D1. Remove this module once a released
 * better-auth stops emitting the pragma join.
 *
 * The fix intercepts that one statement at the **D1 binding**, not inside kysely:
 * better-auth builds its D1 dialect from the binding we hand it, and the dialect
 * itself is not a public export (it ships as a content-hashed internal chunk), so
 * the binding is the only stable seam. `sqlite_master` on its own IS readable, and
 * it already carries everything the caller needs — each index's `CREATE INDEX` text
 * states uniqueness, the column list, and any partial `WHERE`. Upstream's own D1
 * dialect parses `sqlite_master.sql` the same way to detect AUTOINCREMENT.
 *
 * Scope: applied only around the migration path, so ordinary request-time queries
 * are untouched. When upstream stops emitting the pragma join the matcher simply
 * stops matching and this becomes inert — the failure mode is "does nothing".
 */

/** One row of the shape `getDatabaseIndexes` expects back from its SQLite query. */
interface IndexIntrospectionRow {
    readonly columnName: string;
    readonly columnPosition: number;
    readonly indexName: string;
    readonly isPartial: number;
    readonly isUnique: number;
    readonly tableName: string;
}

/** The minimum of `D1Database` this module touches. */
interface D1Like {
    prepare: (query: string) => unknown;
}

/** Upstream's statement is the only one that pairs a pragma index function with `sqlite_master`. */
const PRAGMA_INDEX_LIST = /pragma_index_list\s*\(/iu;

const SQLITE_MASTER = /sqlite_master/iu;

/** SQL quoting around an identifier: double quotes, backticks, or brackets. */
const IDENTIFIER_QUOTE = /^["`[]|["\]`]$/gu;

const WHITESPACE = /\s+/u;

const CREATE_UNIQUE_INDEX = /create\s+unique\s+index/iu;

const WHERE_KEYWORD = /\bwhere\b/iu;

/**
 * Recognise upstream's index-introspection statement.
 *
 * Deliberately narrow — it must match that query and nothing else, so a future
 * better-auth that asks D1 something legitimate is never intercepted.
 */
const isIndexIntrospectionQuery = (query: string): boolean => PRAGMA_INDEX_LIST.test(query) && SQLITE_MASTER.test(query);

/**
 * Strip SQL quoting and any trailing `COLLATE …` / `ASC` / `DESC` from an indexed
 * column. The entries better-auth generates are bare identifiers, so the first
 * whitespace-delimited token is the name — which also avoids a backtracking-prone
 * alternation over input of unbounded length.
 */
const normaliseIndexedColumn = (raw: string): string => (raw.trim().split(WHITESPACE)[0] ?? "").replaceAll(IDENTIFIER_QUOTE, "").trim();

/**
 * Split a `CREATE INDEX` statement into its indexed columns and whatever follows
 * them (the partial-index predicate, if any).
 *
 * Scans to the paren matching the first `(` rather than taking the last one: a
 * partial index ends with its own `WHERE (…)`, so `lastIndexOf(")")` would both
 * swallow the column list and hide the predicate.
 */
const parseIndexClause = (createSql: string): { columns: string[]; tail: string } => {
    const open = createSql.indexOf("(");

    if (open === -1) {
        return { columns: [], tail: "" };
    }

    let depth = 0;

    for (let position = open; position < createSql.length; position += 1) {
        const character = createSql[position];

        if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth -= 1;

            if (depth === 0) {
                return {
                    columns: createSql
                        .slice(open + 1, position)
                        .split(",")
                        .map((column) => normaliseIndexedColumn(column))
                        .filter((column) => column !== ""),
                    tail: createSql.slice(position + 1),
                };
            }
        }
    }

    return { columns: [], tail: "" };
};

/**
 * Read every index from `sqlite_master` and flatten it into the row shape the
 * caller's aggregation step expects (one row per index column).
 */
const readIndexRows = async (database: D1Like): Promise<IndexIntrospectionRow[]> => {
    const statement = database.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'") as {
        all: () => Promise<{ results?: ReadonlyArray<Record<string, unknown>> }>;
    };
    const { results } = await statement.all();
    const rows: IndexIntrospectionRow[] = [];

    for (const definition of results ?? []) {
        const indexName = definition["name"];
        const tableName = definition["tbl_name"];
        const createSql = definition["sql"];

        // Indexes backing UNIQUE / PRIMARY KEY constraints carry a NULL `sql`. They are
        // not indexes the migrator declares, so leaving them out is correct — reporting
        // them with no columns would only mark them unusable for comparison anyway.
        if (typeof indexName !== "string" || typeof tableName !== "string" || typeof createSql !== "string") {
            continue;
        }

        const isUnique = CREATE_UNIQUE_INDEX.test(createSql) ? 1 : 0;
        const { columns, tail } = parseIndexClause(createSql);
        // The predicate follows the column list; checking only the tail keeps a column
        // literally named "where" from reading as a partial index.
        const isPartial = WHERE_KEYWORD.test(tail) ? 1 : 0;

        for (const [columnPosition, columnName] of columns.entries()) {
            rows.push({ columnName, columnPosition, indexName, isPartial, isUnique, tableName });
        }
    }

    return rows;
};

/** A prepared-statement stand-in that answers with pre-computed rows. */
const introspectionStatement = (database: D1Like): unknown => {
    const respond = async () => {
        const results = await readIndexRows(database);

        return { meta: {}, results, success: true };
    };

    // `bind`/`all`/`run` only: kysely's D1 connection calls `.bind(...).all()`, and a
    // narrower stand-in can't quietly return the wrong shape somewhere unexpected.
    const statement = {
        all: respond,
        bind: () => statement,
        run: respond,
    };

    return statement;
};

/**
 * Wrap a D1 binding so better-auth's index introspection works.
 *
 * Everything except the one offending statement passes straight through to the
 * real binding.
 */
export const withD1IndexIntrospection = <T extends D1Like>(database: T): T =>
    new Proxy(database, {
        get(target, property, receiver) {
            if (property === "prepare") {
                return (query: string): unknown => (isIndexIntrospectionQuery(query) ? introspectionStatement(target) : target.prepare(query));
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            // Bind methods to the real binding. Handed back unbound, they would run with
            // `this` set to the proxy, and any implementation that brand-checks `this`
            // (a `#private` field, a native slot) throws `Cannot read private member`.
            // better-auth's own D1 introspector calls `.batch()` on the object we return
            // here, so this is on the live path, not hypothetical. workerd's current D1
            // happens to use `_`-prefixed state and survives either way — which is
            // exactly why the bug would surface later, somewhere else, as a mystery.
            return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
        },
    });

/** True when `value` looks like a D1 binding (rather than a kysely dialect or an adapter). */
export const isD1Database = (value: unknown): value is D1Like =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function" &&
    typeof (value as { batch?: unknown }).batch === "function";
