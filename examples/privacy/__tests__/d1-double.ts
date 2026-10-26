/**
 * An in-memory D1 for the node suite. It answers the statement shapes `lunora/privacy-auth.ts` issues: the table
 * list, a subject's rows, a subject's count, and a delete, each with a WHERE clause of one or more `"column" = ?`
 * conditions joined by OR. The tables are better-auth's `user`, `session`, `account` and `verification`. The
 * workerd suite runs the same statements against real D1, so a statement this double does not answer throws.
 */
import type { AuthDatabase, AuthStatement } from "../lunora/privacy-auth";

type Row = Record<string, unknown>;

/** The sign-in tables by name, each a list of rows. */
export type Tables = Map<string, Row[]>;

const SELECT_TABLES = /^SELECT name FROM sqlite_master WHERE type = 'table'$/u;
const SELECT_ROWS = /^SELECT \* FROM "(\w+)" WHERE (.+)$/u;
const SELECT_COUNT = /^SELECT COUNT\(\*\) AS count FROM "(\w+)" WHERE (.+)$/u;
const DELETE_ROWS = /^DELETE FROM "(\w+)" WHERE (.+)$/u;
const CONDITION = /^"(\w+)" = \?$/u;

const rowsIn = (tables: Tables, table: string): Row[] => {
    const rows = tables.get(table);

    if (rows === undefined) {
        throw new Error(`The D1 double has no table "${table}".`);
    }

    return rows;
};

/**
 * Whether a row meets a WHERE clause of `"column" = ?` conditions joined by OR. The values are bound in the order
 * the conditions list their placeholders.
 */
const matches = (row: Row, where: string, values: unknown[]): boolean => {
    let next = 0;

    return where.split(" OR ").some((condition) => {
        const found = CONDITION.exec(condition.trim());

        if (found === null) {
            throw new Error(`The D1 double does not answer the condition: ${condition}`);
        }

        const value = values[next];

        next += 1;

        return row[found[1] ?? ""] === value;
    });
};

/** A statement over `tables`, with the values bound so far. Anything outside the statement shapes throws. */
const statementOver = (tables: Tables, query: string, values: unknown[]): AuthStatement => {
    const run = (): { readonly results: Row[] } => {
        if (SELECT_TABLES.test(query)) {
            return {
                results: [...tables.keys()].map((name) => {
                    return { name };
                }),
            };
        }

        const select = SELECT_ROWS.exec(query);

        if (select !== null) {
            const [, table = "", where = ""] = select;

            return { results: rowsIn(tables, table).filter((row) => matches(row, where, values)) };
        }

        const count = SELECT_COUNT.exec(query);

        if (count !== null) {
            const [, table = "", where = ""] = count;

            return { results: [{ count: rowsIn(tables, table).filter((row) => matches(row, where, values)).length }] };
        }

        const remove = DELETE_ROWS.exec(query);

        if (remove !== null) {
            const [, table = "", where = ""] = remove;

            tables.set(
                table,
                rowsIn(tables, table).filter((row) => !matches(row, where, values)),
            );

            return { results: [] };
        }

        throw new Error(`The D1 double does not answer: ${query}`);
    };

    return {
        all: async () => run(),
        bind: (...bound: unknown[]) => statementOver(tables, query, bound),
        run: async () => {
            run();

            return {};
        },
    };
};

/** A fresh in-memory database with the four sign-in tables, and the binding that reads it. */
export const d1Double = (): { readonly db: AuthDatabase; readonly tables: Tables } => {
    const tables: Tables = new Map([
        ["account", []],
        ["session", []],
        ["user", []],
        ["verification", []],
    ]);

    const db: AuthDatabase = {
        // Like D1's batch: in order, and rolled back as a whole when one statement fails.
        batch: async (statements) => {
            const before = structuredClone(tables);

            try {
                const results = await Promise.all(statements.map(async (statement) => statement.run()));

                return results;
            } catch (error) {
                tables.clear();

                for (const [name, rows] of before) {
                    tables.set(name, rows);
                }

                throw error;
            }
        },
        prepare: (query: string) => statementOver(tables, query, []),
    };

    return { db, tables };
};

/** One subject's sign-in rows: a user, a session, a password account and an email-verification record. */
export const seedSignIn = (tables: Tables, userId: string): void => {
    rowsIn(tables, "user").push({ email: `${userId}@example.test`, id: userId, name: userId });
    rowsIn(tables, "session").push({ id: `${userId}-session`, token: `${userId}-token`, userId });
    rowsIn(tables, "account").push({ id: `${userId}-account`, providerId: "credential", userId });
    rowsIn(tables, "verification").push({ id: `${userId}-verification`, identifier: `${userId}@example.test`, value: "code" });
};
