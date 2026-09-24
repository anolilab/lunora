import type { CustomAdapter } from "better-auth/adapters";

/** A stored auth row — an opaque bag of columns keyed by better-auth field name. */
type AuthRow = Record<string, unknown>;

/**
 * One normalized better-auth where clause. Derived from {@link CustomAdapter}'s
 * own method signature (rather than re-declared) so a better-auth change to the
 * clause shape surfaces as a compile error here, not a silent mis-match.
 */
type AuthWhereClause = NonNullable<Parameters<CustomAdapter["findOne"]>[0]["where"]>[number];

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// better-auth's where values and the SQL columns they target are genuinely
// nullable, so a `null`-or-`undefined` check is real domain logic.
const isNullish = (value: unknown): boolean => value === undefined || value === null;

/** Case-insensitive `===` for strings; falls back to strict equality otherwise. */
const looseEquals = (left: unknown, right: unknown, insensitive: boolean): boolean => {
    if (insensitive) {
        const a = asString(left);
        const b = asString(right);

        if (a !== undefined && b !== undefined) {
            return a.toLowerCase() === b.toLowerCase();
        }
    }

    return left === right;
};

/** `contains`/`starts_with`/`ends_with`, with optional case folding. Non-strings never match. */
const matchesPattern = (cell: unknown, value: unknown, operator: "contains" | "ends_with" | "starts_with", insensitive: boolean): boolean => {
    const haystack = asString(cell);
    const needle = asString(value);

    if (haystack === undefined || needle === undefined) {
        return false;
    }

    const [a, b] = insensitive ? [haystack.toLowerCase(), needle.toLowerCase()] : [haystack, needle];

    if (operator === "contains") {
        return a.includes(b);
    }

    return operator === "starts_with" ? a.startsWith(b) : a.endsWith(b);
};

/** Evaluate one clause against a row. Mirrors better-auth's memory-adapter operator semantics. */
const evaluateClause = (row: AuthRow, clause: AuthWhereClause): boolean => {
    const { field, mode, operator, value } = clause;
    const cell = row[field];
    const insensitive = mode === "insensitive";

    switch (operator) {
        case "contains":
        case "ends_with":
        case "starts_with": {
            return matchesPattern(cell, value, operator, insensitive);
        }
        case "gt": {
            return !isNullish(value) && (cell as number) > (value as number);
        }
        case "gte": {
            return !isNullish(value) && (cell as number) >= (value as number);
        }
        case "in": {
            return Array.isArray(value) && value.some((entry) => looseEquals(cell, entry, insensitive));
        }
        case "lt": {
            return !isNullish(value) && (cell as number) < (value as number);
        }
        case "lte": {
            return !isNullish(value) && (cell as number) <= (value as number);
        }
        case "ne": {
            return !looseEquals(cell, value, insensitive);
        }
        case "not_in": {
            return Array.isArray(value) && !value.some((entry) => looseEquals(cell, entry, insensitive));
        }
        // "eq" and the default: null-aware equality.
        default: {
            return isNullish(value) ? isNullish(cell) : looseEquals(cell, value, insensitive);
        }
    }
};

/** Compare two non-nullish cells for {@link sortRows}: strings by locale, everything else numerically (dates/booleans coerce). */
const compareCells = (a: unknown, b: unknown): number => {
    if (typeof a === "string" && typeof b === "string") {
        return a.localeCompare(b);
    }

    const left = Number(a);
    const right = Number(b);

    if (left < right) {
        return -1;
    }

    return left > right ? 1 : 0;
};

/** Stable sort honouring better-auth's null-first, type-aware comparator. */
const sortRows = (rows: AuthRow[], sortBy: { direction: "asc" | "desc"; field: string }): AuthRow[] => {
    const direction = sortBy.direction === "asc" ? 1 : -1;

    return rows.toSorted((left, right) => {
        const a = left[sortBy.field];
        const b = right[sortBy.field];

        if (isNullish(a) && isNullish(b)) {
            return 0;
        }

        if (isNullish(a)) {
            return -direction;
        }

        if (isNullish(b)) {
            return direction;
        }

        return compareCells(a, b) * direction;
    });
};

/** Read query handed to {@link AuthStore.read}: a where filter plus optional sort/window. */
export interface AuthQuery {
    limit?: number;
    offset?: number;
    sortBy?: { direction: "asc" | "desc"; field: string };
    where: ReadonlyArray<AuthWhereClause>;
}

/**
 * The minimal table-addressed store the `lunoraAuthAdapter` drives. This is the
 * seam a Lunora runtime binds to its ORM: back each method with `ctx.db` over
 * the global (D1) auth tables that `authTables(...)` generates, and better-auth's
 * reads/writes flow through Lunora's data layer (triggers, aggregates, OCC)
 * instead of better-auth's own adapter. Field names and table (`model`) names are
 * already the database names better-auth resolved from the schema, so a store
 * passes them straight through.
 *
 * {@link createMemoryAuthStore} is a reference in-memory implementation (also
 * what the tests run better-auth against); `createSqlAuthStore` is the SQL one.
 */
export interface AuthStore {
    /**
     * Atomically delete **at most one** row in `model` matching `where` and
     * return it (or `undefined` if none matched). Backs better-auth's
     * single-use-token consume (OTP / magic-link / email-verification /
     * password-reset): implementing it natively — one round trip that finds and
     * deletes in a single statement — closes the read-then-delete race the
     * factory's `findMany` + `deleteMany` fallback would otherwise leave open.
     */
    consumeOne: (model: string, where: ReadonlyArray<AuthWhereClause>) => Promise<AuthRow | undefined>;
    /** Count rows in `model` matching `where` (empty `where` = all rows). */
    count: (model: string, where: ReadonlyArray<AuthWhereClause>) => Promise<number>;
    /** Insert `data` into `model`; return the stored row (the adapter pre-fills `id`). */
    create: (model: string, data: AuthRow) => Promise<AuthRow>;

    /**
     * Atomically apply signed numeric deltas to **at most one** row in `model`
     * matching `where`, then return the updated row (or `undefined` if the guard
     * matched none). For each `increment` entry it applies `field = field + delta`
     * (a negative delta decrements); the optional `set` map assigns absolute
     * values in the same step. The `where` clause is both selector **and** guard
     * — comparison operators are honoured, so a guard like
     * `{ field: "count", operator: "lt", value: max }` only mutates the row while
     * it still satisfies the predicate.
     *
     * Backs better-auth's durable (`storage: "database"`) rate limiter, whose
     * counter rides these tables. Implementing it natively — one statement that
     * guards, increments, and returns — gives the **one-winner-across-isolates**
     * guarantee the read-then-update fallback cannot: on Workers two concurrent
     * requests would otherwise both read `count=4` and both write `5`, letting a
     * `max` of 5 pass 6+. Same race-closing rationale as {@link AuthStore.consumeOne}.
     */
    incrementOne: (model: string, where: ReadonlyArray<AuthWhereClause>, increment: Record<string, number>, set?: AuthRow) => Promise<AuthRow | undefined>;
    /** Read rows from `model` honouring the filter/sort/window in `query`. */
    read: (model: string, query: AuthQuery) => Promise<AuthRow[]>;
    /** Delete rows in `model` matching `where`; return how many were removed. */
    remove: (model: string, where: ReadonlyArray<AuthWhereClause>) => Promise<number>;
    /** Patch rows in `model` matching `where` with `values`; return the updated rows. */
    update: (model: string, where: ReadonlyArray<AuthWhereClause>, values: AuthRow) => Promise<AuthRow[]>;
}

/**
 * Evaluate a better-auth where clause list against a row.
 *
 * better-auth hands an adapter a FLAT list in which each clause carries its own
 * `connector` (`AND` by default). Every persistent adapter it ships resolves that
 * by PARTITIONING: `AND(and-clauses) AND OR(or-clauses)`. The OR clauses are
 * alternatives among themselves, never an escape hatch from the AND clauses —
 * `@better-auth/kysely-adapter` pushes each group into its own `.where()` (two
 * `.where()` calls are ANDed), `@better-auth/drizzle-adapter` ends in
 * `and(andClause, orClause)`, and `@better-auth/prisma-adapter` emits
 * `{ AND: […], OR: […] }`, which Prisma also ANDs.
 *
 * This used to fold the list left-associatively instead, so `[A, B(OR), C(OR)]`
 * meant `A OR B OR C` — strictly BROADER than any of them. On a credential lookup
 * that is an authentication bypass in shape: a row failing the primary condition
 * is still returned because a secondary one matched. `@better-auth/memory-adapter`
 * does fold left, but it is the only one and it re-evaluates `where[0]` inside the
 * same loop; the persistent adapters are the contract worth mirroring, and they
 * are also what a plugin author will have tested against.
 *
 * An empty list matches every row, and a list with no OR clause is unaffected —
 * which is every clause list better-auth 1.7.1 itself builds. Exported so any
 * in-memory-style {@link AuthStore} can reuse it.
 */
export const matchesWhere = (row: AuthRow, where: ReadonlyArray<AuthWhereClause>): boolean => {
    const alternatives = where.filter((clause) => clause.connector === "OR");
    const required = where.filter((clause) => clause.connector !== "OR");

    return required.every((clause) => evaluateClause(row, clause)) && (alternatives.length === 0 || alternatives.some((clause) => evaluateClause(row, clause)));
};

/**
 * Reference in-memory {@link AuthStore} — used to run better-auth end to end in
 * tests, and a worked example of the contract a Lunora-`ctx.db`-backed store
 * fulfils. Not for production (state is per-instance and non-durable).
 */
export const createMemoryAuthStore = (): AuthStore => {
    const tables = new Map<string, AuthRow[]>();
    const tableOf = (model: string): AuthRow[] => {
        const existing = tables.get(model);

        if (existing) {
            return existing;
        }

        const created: AuthRow[] = [];

        tables.set(model, created);

        return created;
    };

    return {
        consumeOne: (model, where) => {
            const table = tableOf(model);
            const index = table.findIndex((row) => matchesWhere(row, where));

            if (index === -1) {
                return Promise.resolve(undefined);
            }

            // Synchronous find-and-splice: no `await` interleaves, so this is an
            // atomic single-row consume even under concurrent callers.
            const [row] = table.splice(index, 1);

            return Promise.resolve(row ? { ...row } : undefined);
        },
        count: (model, where) => Promise.resolve(tableOf(model).filter((row) => matchesWhere(row, where)).length),
        create: (model, data) => {
            const row = { ...data };

            tableOf(model).push(row);

            return Promise.resolve({ ...row });
        },
        incrementOne: (model, where, increment, set) => {
            const row = tableOf(model).find((candidate) => matchesWhere(candidate, where));

            if (!row) {
                return Promise.resolve(undefined);
            }

            // Synchronous guarded read-modify-write: no `await` interleaves
            // between the guard match and the mutation, so this is atomic even
            // under concurrent callers — the in-memory analogue of the SQL
            // `UPDATE … RETURNING`. `increment` and `set` target disjoint columns
            // in better-auth's usage; deltas add onto the current value.
            for (const [field, delta] of Object.entries(increment)) {
                row[field] = (typeof row[field] === "number" ? row[field] : 0) + delta;
            }

            if (set) {
                Object.assign(row, set);
            }

            return Promise.resolve({ ...row });
        },
        read: (model, query) => {
            let rows = tableOf(model).filter((row) => matchesWhere(row, query.where));

            if (query.sortBy) {
                rows = sortRows(rows, query.sortBy);
            }

            if (query.offset) {
                rows = rows.slice(query.offset);
            }

            if (query.limit !== undefined) {
                rows = rows.slice(0, query.limit);
            }

            return Promise.resolve(
                rows.map((row) => {
                    return { ...row };
                }),
            );
        },
        remove: (model, where) => {
            const table = tableOf(model);
            const kept = table.filter((row) => !matchesWhere(row, where));
            const removed = table.length - kept.length;

            table.length = 0;
            table.push(...kept);

            return Promise.resolve(removed);
        },
        update: (model, where, values) => {
            const matched = tableOf(model).filter((row) => matchesWhere(row, where));

            for (const row of matched) {
                Object.assign(row, values);
            }

            return Promise.resolve(
                matched.map((row) => {
                    return { ...row };
                }),
            );
        },
    };
};

export type { AuthRow, AuthWhereClause };
