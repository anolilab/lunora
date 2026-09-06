import type { AuthRow, AuthStore, AuthWhereClause } from "./store";

/** Double-quote a table/column identifier, escaping embedded quotes. */
const quoteId = (name: string): string => `"${name.replaceAll('"', '""')}"`;

interface SqlFragment {
    params: unknown[];
    sql: string;
}

/** A fragment that never matches — mirrors the in-memory evaluator returning `false`. */
const NEVER: SqlFragment = { params: [], sql: "0" };

/** `column`, lower-cased when `insensitive`; the placeholder gets the same treatment. */
const sided = (column: string, insensitive: boolean): { column: string; placeholder: string } =>
    insensitive ? { column: `LOWER(${column})`, placeholder: "LOWER(?)" } : { column, placeholder: "?" };

/**
 * `contains`/`starts_with`/`ends_with` via `instr`/`substr` rather than `LIKE`,
 * so the match is **case-sensitive by default** (honouring `mode`, like the
 * in-memory store) instead of `LIKE`'s ASCII-case-insensitivity. A non-string
 * value never matches — same as the in-memory `matchesPattern`.
 */
const patternFragment = (column: string, value: unknown, operator: "contains" | "ends_with" | "starts_with", insensitive: boolean): SqlFragment => {
    if (typeof value !== "string") {
        return NEVER;
    }

    const side = sided(column, insensitive);

    if (operator === "contains") {
        return { params: [value], sql: `instr(${side.column}, ${side.placeholder}) > 0` };
    }

    if (operator === "starts_with") {
        return { params: [value], sql: `instr(${side.column}, ${side.placeholder}) = 1` };
    }

    // ends_with: compare the trailing `length(value)` characters.
    return { params: [value, value], sql: `substr(${side.column}, -length(?)) = ${side.placeholder}` };
};

/** `=`/`<>` equality (or `IS [NOT] NULL`), with optional case folding. `negated` flips it to `ne`. */
const equalityFragment = (column: string, value: unknown, insensitive: boolean, negated: boolean): SqlFragment => {
    if (value === null) {
        return { params: [], sql: `${column} IS ${negated ? "NOT " : ""}NULL` };
    }

    const side = sided(column, insensitive);
    const symbol = negated ? "<>" : "=";

    return { params: [value], sql: `${side.column} ${symbol} ${side.placeholder}` };
};

/** `IN`/`NOT IN` over an array, with optional case folding. Empty `IN ()` matches nothing; empty `NOT IN ()` excludes nothing. */
const inFragment = (column: string, value: unknown, negated: boolean, insensitive: boolean): SqlFragment => {
    const values: unknown[] = Array.isArray(value) ? value : [];

    if (values.length === 0) {
        return { params: [], sql: negated ? "1" : "0" };
    }

    const side = sided(column, insensitive);
    const placeholders = values.map(() => side.placeholder).join(", ");

    return { params: [...values], sql: `${side.column} ${negated ? "NOT IN" : "IN"} (${placeholders})` };
};

/** Compile one better-auth clause to a parameterized SQL fragment. */
const compileClause = (clause: AuthWhereClause): SqlFragment => {
    const column = quoteId(clause.field);
    const { mode, operator, value } = clause;
    const insensitive = mode === "insensitive";

    switch (operator) {
        case "contains":
        case "ends_with":
        case "starts_with": {
            return patternFragment(column, value, operator, insensitive);
        }
        case "gt": {
            return { params: [value], sql: `${column} > ?` };
        }
        case "gte": {
            return { params: [value], sql: `${column} >= ?` };
        }
        case "in": {
            return inFragment(column, value, false, insensitive);
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
            return inFragment(column, value, true, insensitive);
        }
        // "eq" and the default: null-aware equality.
        default: {
            return equalityFragment(column, value, insensitive, false);
        }
    }
};

/** Join one connector group into a parenthesized fragment, or `undefined` when the group is empty. */
const compileGroup = (clauses: ReadonlyArray<AuthWhereClause>, joiner: "AND" | "OR"): SqlFragment | undefined => {
    if (clauses.length === 0) {
        return undefined;
    }

    const fragments = clauses.map((clause) => compileClause(clause));

    return { params: fragments.flatMap((fragment) => fragment.params), sql: fragments.map((fragment) => `(${fragment.sql})`).join(` ${joiner} `) };
};

/**
 * Compile a better-auth where clause list into a single SQL fragment (no leading
 * `WHERE`).
 *
 * The list is PARTITIONED by `connector` into an AND group and an OR group, and
 * the two groups are then ANDed — the same grouping every persistent better-auth
 * adapter produces — and the same grouping `store.ts`'s `matchesWhere` applies,
 * which this must agree with clause for clause. Every group is parenthesized, so
 * SQL's `AND`-over-`OR` precedence cannot regroup it.
 *
 * Folding left-associatively instead — as this did — turns `[A, B(OR), C(OR)]`
 * into `A OR B OR C`, which returns rows failing `A`. On a credential lookup that
 * is an authentication bypass in shape. An empty list compiles to an empty
 * fragment; a list with no OR clause compiles to the same conjunction as before.
 */
const compileWhere = (where: ReadonlyArray<AuthWhereClause>): SqlFragment => {
    const groups = [
        compileGroup(
            where.filter((clause) => clause.connector !== "OR"),
            "AND",
        ),
        compileGroup(
            where.filter((clause) => clause.connector === "OR"),
            "OR",
        ),
    ].filter((group): group is SqlFragment => group !== undefined);

    if (groups.length === 0) {
        return { params: [], sql: "" };
    }

    return { params: groups.flatMap((group) => group.params), sql: groups.map((group) => `(${group.sql})`).join(" AND ") };
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
 * same `{ all, run }` contract as `@lunora/d1`'s `D1Exec`, so a Lunora D1 binding
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
 * same database that hosts Lunora's global (D1) tables (the ones `authTables(...)`
 * generates) and better-auth's reads/writes land there as ordinary rows Lunora
 * can also query. Assumes the auth tables already exist (Lunora owns the schema /
 * migrations); it never issues DDL.
 *
 * ```ts
 * const store = createSqlAuthStore(d1Executor(env.DB));
 * const auth = createAuth({ secret: env.AUTH_SECRET, database: lunoraAuthAdapter(store) });
 * ```
 *
 * Clause semantics match `createMemoryAuthStore` (operator parity is
 * covered by a cross-store agreement test) with one unavoidable caveat:
 * case-**insensitive** matching uses SQLite's ASCII-only `LOWER()`, whereas the
 * in-memory store uses JS full-Unicode `toLowerCase()`. They agree on ASCII
 * (emails, ids, tokens — the credential path); they can differ only for
 * case-insensitive comparison of non-ASCII text.
 */
export const createSqlAuthStore = (executor: SqlExecutor): AuthStore => {
    const selectRows = (model: string, where: ReadonlyArray<AuthWhereClause>): Promise<AuthRow[]> => {
        const fragment = compileWhere(where);

        return executor.all(`SELECT * FROM ${quoteId(model)}${whereSuffix(fragment)}`, fragment.params);
    };

    return {
        consumeOne: async (model, where) => {
            const fragment = compileWhere(where);
            const table = quoteId(model);

            // One statement that finds and deletes a single row: the subquery
            // pins exactly one `rowid` (SQLite/D1 lack `DELETE … LIMIT`), the
            // DELETE removes it, and RETURNING hands it back — atomic consume, no
            // read-then-delete race.
            const [row] = await executor.all(
                `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}${whereSuffix(fragment)} LIMIT 1) RETURNING *`,
                fragment.params,
            );

            return row;
        },
        count: async (model, where) => {
            const fragment = compileWhere(where);
            // `__count` rather than `count` so the alias can't collide with a real
            // column named `count`.
            const [row] = await executor.all(`SELECT COUNT(*) AS __count FROM ${quoteId(model)}${whereSuffix(fragment)}`, fragment.params);

            return Number(row?.["__count"] ?? 0);
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
        incrementOne: async (model, where, increment, set) => {
            const table = quoteId(model);
            const incrementColumns = Object.keys(increment);
            const setColumns = set ? Object.keys(set) : [];
            const fragment = compileWhere(where);

            // An empty increment+set can't form a valid `SET`. better-auth never
            // calls it that way, but mirror `update`'s empty-patch handling: treat
            // it as a pure guard read of the single matching row.
            if (incrementColumns.length === 0 && setColumns.length === 0) {
                const [row] = await executor.all(`SELECT * FROM ${table}${whereSuffix(fragment)} LIMIT 1`, fragment.params);

                return row;
            }

            const assignments = [
                // COALESCE(col, 0) so a NULL counter advances from 0 rather than staying
                // NULL (`NULL + ? = NULL` in SQLite/D1) — matches the memory store, which
                // treats a non-numeric/absent counter as 0.
                ...incrementColumns.map((column) => `${quoteId(column)} = COALESCE(${quoteId(column)}, 0) + ?`),
                ...setColumns.map((column) => `${quoteId(column)} = ?`),
            ].join(", ");

            // Guarded read-modify-write in one statement: the subquery pins a
            // single `rowid` the guard still matches (SQLite/D1 lack `UPDATE …
            // LIMIT`), the UPDATE applies `col = col + delta` / `col = value`
            // atomically, and RETURNING hands back the post-update row. One winner
            // across isolates — no read-then-update race the memory/`findMany +
            // updateMany` fallback would leave open on Workers.
            const [row] = await executor.all(
                `UPDATE ${table} SET ${assignments} WHERE rowid IN (SELECT rowid FROM ${table}${whereSuffix(fragment)} LIMIT 1) RETURNING *`,
                [...incrementColumns.map((column) => increment[column]), ...setColumns.map((column) => (set as AuthRow)[column]), ...fragment.params],
            );

            return row;
        },
        read: async (model, query) => {
            const fragment = compileWhere(query.where);
            const parameters = [...fragment.params];
            let sql = `SELECT * FROM ${quoteId(model)}${whereSuffix(fragment)}`;

            if (query.sortBy) {
                sql += ` ORDER BY ${quoteId(query.sortBy.field)} ${query.sortBy.direction === "asc" ? "ASC" : "DESC"}`;
            }

            // Bind LIMIT/OFFSET as parameters too, so nothing but quoted identifiers
            // and `?` placeholders ever reaches SQL. SQLite needs a LIMIT before
            // OFFSET; `-1` means "no limit".
            if (query.limit !== undefined) {
                sql += " LIMIT ?";
                parameters.push(Math.trunc(query.limit));
            }

            if (query.offset) {
                sql += `${query.limit === undefined ? " LIMIT -1" : ""} OFFSET ?`;
                parameters.push(Math.trunc(query.offset));
            }

            return executor.all(sql, parameters);
        },
        remove: async (model, where) => {
            const fragment = compileWhere(where);
            // DELETE … RETURNING finds and deletes in one statement, so the count
            // is exactly the rows removed — no read-then-delete drift.
            const deleted = await executor.all(`DELETE FROM ${quoteId(model)}${whereSuffix(fragment)} RETURNING *`, fragment.params);

            return deleted.length;
        },
        update: async (model, where, values) => {
            const columns = Object.keys(values);

            // An empty patch can't form a valid `SET`; return the matching rows unchanged.
            if (columns.length === 0) {
                return selectRows(model, where);
            }

            const assignments = columns.map((column) => `${quoteId(column)} = ?`).join(", ");
            const fragment = compileWhere(where);

            // UPDATE … RETURNING applies the patch and hands back the post-update
            // rows in one statement — the result reflects committed DB state, not a
            // client-side merge of a separate pre-update read.
            return executor.all(`UPDATE ${quoteId(model)} SET ${assignments}${whereSuffix(fragment)} RETURNING *`, [
                ...columns.map((column) => values[column]),
                ...fragment.params,
            ]);
        },
    };
};

/**
 * Wrap a Cloudflare D1 binding (`env.DB`) as a {@link SqlExecutor}, so
 * `createSqlAuthStore(d1Executor(env.DB))` routes better-auth onto D1 — the same
 * binding Lunora's `.global()` tables use.
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
