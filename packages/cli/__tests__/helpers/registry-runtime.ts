/**
 * Shared by the suites that EXECUTE shipped registry and template code over an
 * in-memory `ctx.db` (`commands/registry-saas-items.test.ts`,
 * `commands/registry-saas-template.test.ts`). `packages/cli/vitest.config.ts`
 * aliases the specifiers the items import.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

type Row = Record<string, unknown>;
type Handler<TArgs, TResult> = (invocation: { args: TArgs; ctx: unknown }) => Promise<TResult>;

/** Load an item through a computed specifier, so this package's `tsc` never sees its aliased imports. */
const load = async <T>(...segments: string[]): Promise<T> => (await import(pathToFileURL(join(root, ...segments)).href)) as T;

/**
 * An in-memory `ctx.db` over named tables with the unique indexes the kit
 * declares. A duplicate on a unique index throws, as the real engine does.
 */
/** A row predicate: every bound field equals its value. */
const equalsAll =
    (bound: Row) =>
    (row: Row): boolean =>
        Object.entries(bound).every(([field, value]) => row[field] === value);

/** SQLite's order for the values the kit sorts on: numbers numerically, text by code unit (BINARY). */
const compare = (left: unknown, right: unknown): number => {
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }

    const [a, b] = [String(left), String(right)];

    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/**
 * The engine's keyset over `orderBy`: its keys plus a creation-time, then row-id tie-break in
 * the last key's direction, so no two rows share a position.
 */
const keyset = (orderBy: Record<string, "asc" | "desc">[]): { order: (left: unknown[], right: unknown[]) => number; tuple: (row: Row) => unknown[] } => {
    const keys: [string, "asc" | "desc"][] = orderBy.map((entry) => Object.entries(entry)[0]!);

    const tiebreak = keys.at(-1)?.[1] ?? "asc";

    keys.push(["_creationTime", tiebreak], ["_id", tiebreak]);

    return {
        order: (left, right) => {
            for (const [index, [, direction]] of keys.entries()) {
                const step = compare(left[index], right[index]);

                if (step !== 0) {
                    return direction === "asc" ? step : -step;
                }
            }

            return 0;
        },
        tuple: (row) => keys.map(([field]) => row[field]),
    };
};

/** The fake: `db` is handed to an item as its `ctx.db`; `rows` reads a table back for an assertion. */
interface FakeDatabase {
    db: Record<string, unknown>;
    rows: (table: string) => Row[];
}

/** One aggregate over a group's rows: its row count, or the sum of `field`. */
const reduceGroup = (grouped: Row[], agg: { field?: string; op: string }): number =>
    agg.op === "count" ? grouped.length : grouped.reduce((total, row) => total + Number(row[agg.field!]), 0);

const createDatabase = (unique: Record<string, string[][]>): FakeDatabase => {
    const tables = new Map<string, Row[]>();
    let counter = 0;

    const rows = (table: string): Row[] => {
        if (!tables.has(table)) {
            tables.set(table, []);
        }

        return tables.get(table)!;
    };

    // The `where` operators the kit's `findMany` / `count` / `aggregate` calls use. An operator the
    // fake does not know throws, so a kit that starts relying on one fails here instead of passing.
    const operators: Record<string, (value: unknown, operand: unknown) => boolean> = {
        // D1's `contains` folds ASCII case (`instr(lower(…), lower(…))`).
        contains: (value, operand) => String(value).toLowerCase().includes(String(operand).toLowerCase()),
        gt: (value, operand) => compare(value, operand) > 0,
        in: (value, operand) => (operand as unknown[]).includes(value),
        lt: (value, operand) => compare(value, operand) < 0,
        ne: (value, operand) => value !== operand,
    };

    const match = (row: Row, where: Row): boolean =>
        Object.entries(where).every(([field, condition]) => {
            if (field === "AND") {
                return (condition as Row[]).every((branch) => match(row, branch));
            }

            if (field === "OR") {
                return (condition as Row[]).some((branch) => match(row, branch));
            }

            if (field === "NOT") {
                return !match(row, condition as Row);
            }

            if (typeof condition !== "object" || condition === null) {
                return row[field] === condition;
            }

            return Object.entries(condition).every(([operator, operand]) => {
                const test = operators[operator];

                if (!test) {
                    throw new Error(`fake db: unsupported where operator ${operator}`);
                }

                return test(row[field], operand);
            });
        });

    const assertUnique = (table: string, candidate: Row): void => {
        for (const fields of unique[table] ?? []) {
            const clash = rows(table).find((row) => row["_id"] !== candidate["_id"] && fields.every((field) => row[field] === candidate[field]));

            if (clash) {
                throw new Error(`UNIQUE constraint failed: ${table}.${fields.join(", ")}`);
            }
        }
    };

    const find = (table: string, id: unknown): Row | undefined => rows(table).find((row) => row["_id"] === id);

    const facade = (table: string) => {
        const matching = (where: Row): Row[] => rows(table).filter((row) => match(row, where));

        return {
            aggregate: async ({ field, op, where = {} }: { field: string; op: string; where?: Row }) => {
                if (op !== "sum") {
                    throw new Error(`fake db: unsupported aggregate ${op}`);
                }

                const found = matching(where);

                return found.length === 0 ? null : found.reduce((total, row) => total + Number(row[field]), 0);
            },
            count: async (where: Row = {}) => matching(where).length,
            groupBy: async ({ agg, by }: { agg: { field?: string; op: string }; by: string[] }) => {
                const groups = new Map<string, { key: Row; rows: Row[] }>();

                for (const row of rows(table)) {
                    const key = Object.fromEntries(by.map((field) => [field, row[field]]));
                    const id = JSON.stringify(key);

                    groups.set(id, { key, rows: [...(groups.get(id)?.rows ?? []), row] });
                }

                return [...groups.values()].map(({ key, rows: grouped }) => {
                    return { key, value: reduceGroup(grouped, agg) };
                });
            },
            findFirst: async ({ where }: { where: Row }) => rows(table).find((row) => match(row, where)) ?? null,
            // Paged the way the engine's `findMany` pages: `cursor` exclusive, `endCursor` inclusive, and a
            // bounded page's `splitCursor` / `splitRequired`. A cursor is the JSON of the row's key tuple.
            findMany: async ({
                cursor,
                endCursor,
                limit,
                orderBy = [],
                where = {},
            }: {
                cursor?: string | null;
                endCursor?: string | null;
                limit?: number;
                orderBy?: Record<string, "asc" | "desc">[];
                where?: Row;
            }) => {
                const { order, tuple } = keyset(orderBy);
                const lower = typeof cursor === "string" ? (JSON.parse(cursor) as unknown[]) : undefined;
                const upper = typeof endCursor === "string" ? (JSON.parse(endCursor) as unknown[]) : undefined;
                const ranged = matching(where)
                    .filter((row) => (lower === undefined || order(tuple(row), lower) > 0) && (upper === undefined || order(tuple(row), upper) <= 0))
                    .toSorted((a, b) => order(tuple(a), tuple(b)));
                const over = limit !== undefined && ranged.length > limit;
                const page = over ? ranged.slice(0, limit) : ranged;
                const encode = (row: Row | undefined): string | null => (row === undefined ? null : JSON.stringify(tuple(row)));

                if (typeof endCursor === "string") {
                    // Under two rows there is no midpoint; a capped one-row page still splits after its row.
                    let middle = over ? page[0] : undefined;

                    if (page.length >= 2) {
                        middle = page[Math.floor(page.length / 2) - 1];
                    }

                    return { continueCursor: endCursor, isDone: true, page, splitCursor: encode(middle), ...(over ? { splitRequired: true } : {}) };
                }

                return { continueCursor: over ? encode(page.at(-1)) : null, isDone: !over, page };
            },
        };
    };

    return {
        db: {
            delete: async (table: string, id: unknown) => {
                const found = find(table, id);

                if (found) {
                    tables.set(
                        table,
                        rows(table).filter((row) => row !== found),
                    );
                }
            },
            get: async (table: string, id: unknown) => find(table, id) ?? null,
            insert: async (table: string, document: Row) => {
                counter += 1;

                const row = { ...document, _creationTime: counter, _id: `${table}:${String(counter)}` };

                assertUnique(table, row);
                rows(table).push(row);

                return row["_id"];
            },
            patch: async (table: string, id: unknown, patch: Row) => {
                const found = find(table, id);

                if (!found) {
                    throw new Error(`no row ${String(id)} in ${table}`);
                }

                const next = { ...found, ...patch };

                assertUnique(table, next);
                Object.assign(found, patch);
            },
            replace: async (table: string, id: unknown, document: Row) => {
                const found = find(table, id);

                if (!found) {
                    throw new Error(`no row ${String(id)} in ${table}`);
                }

                const next = { ...document, _id: found["_id"] };

                assertUnique(table, next);
                tables.set(
                    table,
                    rows(table).map((row) => (row === found ? next : row)),
                );
            },
            query: (table: string) => {
                let predicate = (_row: Row) => true;
                let descending = false;

                const ordered = (): Row[] => {
                    const matching = rows(table).filter((row) => predicate(row));

                    return descending ? matching.toReversed() : matching;
                };

                const query = {
                    collect: async () => rows(table).filter((row) => predicate(row)),
                    filter: (callback: (row: Row) => boolean) => {
                        const previous = predicate;

                        predicate = (row) => previous(row) && callback(row);

                        return query;
                    },
                    first: async () => rows(table).find((row) => predicate(row)) ?? null,
                    order: (direction: "asc" | "desc") => {
                        descending = direction === "desc";

                        return query;
                    },
                    // Keyset over the row's `_id`, the way the engine's cursor names a position rather than an offset.
                    paginate: async ({ cursor, endCursor, numItems }: { cursor?: string | null; endCursor?: string | null; numItems: number }) => {
                        const all = ordered();
                        const from = cursor ? all.findIndex((row) => row["_id"] === cursor) + 1 : 0;

                        if (endCursor) {
                            const to = all.findIndex((row) => row["_id"] === endCursor) + 1;

                            return { continueCursor: endCursor, isDone: true, page: all.slice(from, to) };
                        }

                        const page = all.slice(from, from + numItems);
                        const isDone = from + numItems >= all.length;

                        return { continueCursor: isDone ? null : (page.at(-1)?.["_id"] as string), isDone, page };
                    },
                    take: async (limit: number) =>
                        rows(table)
                            .filter((row) => predicate(row))
                            .slice(0, limit),
                    withIndex: (_name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
                        const bound: Row = {};
                        const q = {
                            eq: (field: string, value: unknown) => {
                                bound[field] = value;

                                return q;
                            },
                        };

                        build(q);
                        predicate = equalsAll(bound);

                        return query;
                    },
                };

                return query;
            },
            saas_organizations: facade("saas_organizations"),
        },
        rows,
    };
};

const signedIn = (claims: Row): { getIdentity: () => Promise<Row> } => {
    return {
        getIdentity: async () => claims,
    };
};

export type { FakeDatabase, Handler, Row };
export { createDatabase, load, signedIn };
