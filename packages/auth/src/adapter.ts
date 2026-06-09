import type { CustomAdapter } from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";

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
 * The minimal table-addressed store the {@link cirrusAuthAdapter} drives. This is
 * the seam a Cirrus runtime binds to its ORM: back each method with `ctx.db`
 * over the global (D1) auth tables that `authTables(...)` generates, and
 * better-auth's reads/writes flow through Cirrus's data layer (triggers,
 * aggregates, OCC) instead of better-auth's own adapter. Field names and table
 * (`model`) names are already the database names better-auth resolved from the
 * schema, so a store passes them straight through.
 *
 * {@link createMemoryAuthStore} is a reference in-memory implementation (also
 * what the tests run better-auth against).
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
    /** Read rows from `model` honouring the filter/sort/window in `query`. */
    read: (model: string, query: AuthQuery) => Promise<AuthRow[]>;
    /** Delete rows in `model` matching `where`; return how many were removed. */
    remove: (model: string, where: ReadonlyArray<AuthWhereClause>) => Promise<number>;
    /** Patch rows in `model` matching `where` with `values`; return the updated rows. */
    update: (model: string, where: ReadonlyArray<AuthWhereClause>, values: AuthRow) => Promise<AuthRow[]>;
}

/**
 * Evaluate a better-auth where clause list against a row. Clauses fold
 * left-to-right by their `connector` (`AND` by default, `OR` when set) — the
 * same precedence better-auth's own adapters use. An empty list matches every
 * row. Exported so any in-memory-style {@link AuthStore} can reuse it.
 */
export const matchesWhere = (row: AuthRow, where: ReadonlyArray<AuthWhereClause>): boolean => {
    let result = true;

    for (const [index, clause] of where.entries()) {
        const clauseResult = evaluateClause(row, clause);

        if (index === 0) {
            result = clauseResult;
        } else if (clause.connector === "OR") {
            result = result || clauseResult;
        } else {
            result = result && clauseResult;
        }
    }

    return result;
};

/**
 * Reference in-memory {@link AuthStore} — used to run better-auth end to end in
 * tests, and a worked example of the contract a Cirrus-`ctx.db`-backed store
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

/**
 * A better-auth database adapter backed by an {@link AuthStore} — the bridge
 * that routes better-auth's reads and writes through Cirrus's data layer
 * instead of better-auth's built-in D1/Kysely adapter. Pass the result as
 * `createAuth({ database: cirrusAuthAdapter(store) })`; better-auth's
 * `createAdapterFactory` handles id generation, default values, field-name
 * mapping and output shaping, so this only translates the cleaned CRUD calls
 * onto the store.
 *
 * ```ts
 * const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     emailAndPassword: { enabled: true },
 *     database: cirrusAuthAdapter(cirrusStore), // cirrusStore writes via ctx.db
 * });
 * ```
 *
 * Scope: the {@link AuthStore} interface is single-table CRUD. better-auth's
 * relational `join` reads (an advanced opt-in) are not handled — pair the
 * adapter with `disableJoins` or let better-auth fall back to per-table reads.
 */
export const cirrusAuthAdapter = (store: AuthStore): ReturnType<typeof createAdapterFactory> =>
    createAdapterFactory({
        adapter: (): CustomAdapter => {
            return {
                consumeOne: async ({ model, where }) => {
                    const row = await store.consumeOne(model, where);

                    // eslint-disable-next-line unicorn/no-null -- better-auth's consumeOne contract returns null when nothing matched
                    return (row ?? null) as never;
                },
                count: async ({ model, where }) => store.count(model, where ?? []),
                create: async ({ data, model }) => (await store.create(model, data)) as never,
                delete: async ({ model, where }) => {
                    await store.remove(model, where);
                },
                deleteMany: async ({ model, where }) => store.remove(model, where),
                findMany: async ({ limit, model, offset, sortBy, where }) => (await store.read(model, { limit, offset, sortBy, where: where ?? [] })) as never,
                findOne: async ({ model, where }) => {
                    const [row] = await store.read(model, { limit: 1, where });

                    // eslint-disable-next-line unicorn/no-null -- better-auth's findOne contract returns null for "not found"
                    return (row ?? null) as never;
                },
                update: async ({ model, update, where }) => {
                    const [row] = await store.update(model, where, update as AuthRow);

                    // eslint-disable-next-line unicorn/no-null -- better-auth's update contract returns null when nothing matched
                    return (row ?? null) as never;
                },
                updateMany: async ({ model, update, where }) => {
                    const updated = await store.update(model, where, update as AuthRow);

                    return updated.length;
                },
            };
        },
        config: {
            adapterId: "cirrus",
            adapterName: "Cirrus Adapter",
            // Conservative flags so the adapter is store-agnostic: better-auth
            // serializes dates/booleans/json to primitives (string/number) before a
            // write and parses them back after a read, so a store — in-memory or
            // SQL — only ever handles primitives, never schema-aware codecs.
            supportsBooleans: false,
            supportsDates: false,
            supportsJSON: false,
            supportsNumericIds: false,
        },
    });

export type { AuthRow, AuthWhereClause };
