import type { AuthRow, AuthStore, AuthWhereClause } from "./adapter.js";

/** Double-quote a table/column identifier, escaping embedded quotes. */
const quoteId = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Escape LIKE wildcards so a literal value can't act as a pattern. Paired with `ESCAPE '\'`. */
const escapeLike = (value: string): string => value.replaceAll(/[\\%_]/gu, (character) => `\\${character}`);

interface SqlFragment {
    params: unknown[];
    sql: string;
}

/** A `LIKE ? ESCAPE '\'` fragment binding `pattern` — shared by contains/starts_with/ends_with. */
const likeFragment = (column: string, pattern: string): SqlFragment => {
    return { params: [pattern], sql: String.raw`${column} LIKE ? ESCAPE '\'` };
};

/** `=`/`&lt;>` equality (or `IS [NOT] NULL`), with optional case folding. `negated` flips it to `ne`. */
const equalityFragment = (column: string, value: unknown, insensitive: boolean, negated: boolean): SqlFragment => {
    if (value === null) {
        return { params: [], sql: `${column} IS ${negated ? "NOT " : ""}NULL` };
    }

    const symbol = negated ? "<>" : "=";

    return insensitive ? { params: [value], sql: `LOWER(${column}) ${symbol} LOWER(?)` } : { params: [value], sql: `${column} ${symbol} ?` };
};

/** `IN`/`NOT IN` over an array. An empty `IN ()` matches nothing; an empty `NOT IN ()` excludes nothing. */
const inFragment = (column: string, value: unknown, negated: boolean): SqlFragment => {
    const values: unknown[] = Array.isArray(value) ? value : [];

    if (values.length === 0) {
        return { params: [], sql: negated ? "1" : "0" };
    }

    return { params: [...values], sql: `${column} ${negated ? "NOT IN" : "IN"} (${values.map(() => "?").join(", ")})` };
};

/** Compile one better-auth clause to a parameterized SQL fragment. */
const compileClause = (clause: AuthWhereClause): SqlFragment => {
    const column = quoteId(clause.field);
    const { mode, operator, value } = clause;
    const insensitive = mode === "insensitive";

    switch (operator) {
        // LIKE is case-insensitive for ASCII in SQLite, so pattern operators are
        // case-insensitive in this store regardless of `mode` — only relevant to
        // search-style queries, never the credential path.
        case "contains": {
            return likeFragment(column, `%${escapeLike(String(value))}%`);
        }
        case "ends_with": {
            return likeFragment(column, `%${escapeLike(String(value))}`);
        }
        case "gt": {
            return { params: [value], sql: `${column} > ?` };
        }
        case "gte": {
            return { params: [value], sql: `${column} >= ?` };
        }
        case "in": {
            return inFragment(column, value, false);
        }
        case "lt": {
            return { params: [value], sql: `${column} < ?` };
        }
        case "lte": {
            return { params: [value], sql: `${column} <= ?` };
        }
        case "ne": {
            return equalityFragment(column, value, insensitive, true);
        }
        case "not_in": {
            return inFragment(column, value, true);
        }
        case "starts_with": {
            return likeFragment(column, `${escapeLike(String(value))}%`);
        }
        // "eq" and the default: null-aware equality.
        default: {
            return equalityFragment(column, value, insensitive, false);
        }
    }
};

/**
 * Compile a better-auth where clause list into a single SQL fragment (no leading
 * `WHERE`). Clauses fold left-to-right by their `connector`, parenthesized so the
 * grouping matches better-auth's own left-associative semantics rather than
 * SQL's `AND`-over-`OR` precedence. An empty list compiles to an empty fragment.
 */
const compileWhere = (where: ReadonlyArray<AuthWhereClause>): SqlFragment => {
    if (where.length === 0) {
        return { params: [], sql: "" };
    }

    let accumulator = compileClause(where[0] as AuthWhereClause);

    for (const clause of where.slice(1)) {
        const fragment = compileClause(clause);
        const connector = clause.connector === "OR" ? "OR" : "AND";

        accumulator = { params: [...accumulator.params, ...fragment.params], sql: `(${accumulator.sql} ${connector} ${fragment.sql})` };
    }

    return accumulator;
};

/** Build the ` WHERE …` suffix (with leading space) or an empty string. */
const whereSuffix = (fragment: SqlFragment): string => (fragment.sql ? ` WHERE ${fragment.sql}` : "");

/** A D1 prepared-statement chain — the slice of `D1Database` {@link d1Executor} needs. */
interface D1Like {
    prepare: (sql: string) => {
        bind: (...values: unknown[]) => {
            all: () => Promise<{ results?: Record<string, unknown>[] }>;
            run: () => Promise<unknown>;
        };
    };
}

/**
 * The minimal SQL seam a {@link createSqlAuthStore} runs on — structurally the
 * same `{ all, run }` contract as `@cirrus/d1`'s `D1Exec`, so a Cirrus D1 binding
 * satisfies it directly (see {@link d1Executor}) and a `node:sqlite` handle does
 * too in tests. `all` runs reads and returns rows; `run` runs writes.
 */
export interface SqlExecutor {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<void>;
}

/**
 * An {@link AuthStore} backed by a SQL database through the {@link SqlExecutor}
 * seam — the production counterpart to `createMemoryAuthStore`. Point it at the
 * same database that hosts Cirrus's global (D1) tables (the ones `authTables(...)`
 * generates) and better-auth's reads/writes land there as ordinary rows Cirrus
 * can also query. Assumes the auth tables already exist (Cirrus owns the schema /
 * migrations); it never issues DDL.
 *
 * ```ts
 * const store = createSqlAuthStore(d1Executor(env.DB));
 * const auth = createAuth({ secret: env.AUTH_SECRET, database: cirrusAuthAdapter(store) });
 * ```
 */
export const createSqlAuthStore = (executor: SqlExecutor): AuthStore => {
    const selectRows = (model: string, where: ReadonlyArray<AuthWhereClause>): Promise<AuthRow[]> => {
        const fragment = compileWhere(where);

        return executor.all(`SELECT * FROM ${quoteId(model)}${whereSuffix(fragment)}`, fragment.params);
    };

    return {
        count: async (model, where) => {
            const fragment = compileWhere(where);
            const [row] = await executor.all(`SELECT COUNT(*) AS count FROM ${quoteId(model)}${whereSuffix(fragment)}`, fragment.params);

            return Number(row?.["count"] ?? 0);
        },
        create: async (model, data) => {
            const columns = Object.keys(data);
            const placeholders = columns.map(() => "?").join(", ");
            const sql = `INSERT INTO ${quoteId(model)} (${columns.map((column) => quoteId(column)).join(", ")}) VALUES (${placeholders})`;

            await executor.run(
                sql,
                columns.map((column) => data[column]),
            );

            return { ...data };
        },
        read: async (model, query) => {
            const fragment = compileWhere(query.where);
            let sql = `SELECT * FROM ${quoteId(model)}${whereSuffix(fragment)}`;

            if (query.sortBy) {
                sql += ` ORDER BY ${quoteId(query.sortBy.field)} ${query.sortBy.direction === "asc" ? "ASC" : "DESC"}`;
            }

            if (query.limit !== undefined) {
                sql += ` LIMIT ${String(Math.trunc(query.limit))}`;
            }

            if (query.offset) {
                // SQLite requires a LIMIT before OFFSET; `-1` means "no limit".
                sql += `${query.limit === undefined ? " LIMIT -1" : ""} OFFSET ${String(Math.trunc(query.offset))}`;
            }

            return executor.all(sql, fragment.params);
        },
        remove: async (model, where) => {
            const matched = await selectRows(model, where);
            const fragment = compileWhere(where);

            await executor.run(`DELETE FROM ${quoteId(model)}${whereSuffix(fragment)}`, fragment.params);

            return matched.length;
        },
        update: async (model, where, values) => {
            const matched = await selectRows(model, where);

            if (matched.length === 0) {
                return [];
            }

            const columns = Object.keys(values);
            const assignments = columns.map((column) => `${quoteId(column)} = ?`).join(", ");
            const fragment = compileWhere(where);

            await executor.run(`UPDATE ${quoteId(model)} SET ${assignments}${whereSuffix(fragment)}`, [
                ...columns.map((column) => values[column]),
                ...fragment.params,
            ]);

            return matched.map((row) => {
                return { ...row, ...values };
            });
        },
    };
};

/**
 * Wrap a Cloudflare D1 binding (`env.DB`) as a {@link SqlExecutor}, so
 * `createSqlAuthStore(d1Executor(env.DB))` routes better-auth onto D1 — the same
 * binding Cirrus's `.global()` tables use.
 */
export const d1Executor = (database: D1Like): SqlExecutor => {
    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all();

            return result.results ?? [];
        },
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
};
