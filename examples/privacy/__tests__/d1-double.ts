/**
 * An in-memory D1 for the node suite. It answers the four statement shapes `lunora/privacy-auth.ts` issues
 * (the table list, a subject's rows, a subject's count, and a delete by subject), over plain arrays. The
 * tables are better-auth's `user`, `session` and `account`. The workerd suite runs the same statements
 * against real D1, so a statement this double does not answer throws rather than guessing.
 */
import type { AuthDatabase, AuthStatement } from "../lunora/privacy-auth";

type Row = Record<string, unknown>;

/** The sign-in tables by name, each a list of rows. */
export type Tables = Map<string, Row[]>;

const SELECT_TABLES = /^SELECT name FROM sqlite_master WHERE type = 'table'$/u;
const SELECT_ROWS = /^SELECT \* FROM "(\w+)" WHERE "(\w+)" = \?$/u;
const SELECT_COUNT = /^SELECT COUNT\(\*\) AS count FROM "(\w+)" WHERE "(\w+)" = \?$/u;
const DELETE_ROWS = /^DELETE FROM "(\w+)" WHERE "(\w+)" = \?$/u;

const rowsIn = (tables: Tables, table: string): Row[] => {
    const rows = tables.get(table);

    if (rows === undefined) {
        throw new Error(`The D1 double has no table "${table}".`);
    }

    return rows;
};

/** A statement over `tables`, with the values bound so far. Anything outside the four shapes throws. */
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
            const [, table = "", column = ""] = select;

            return { results: rowsIn(tables, table).filter((row) => row[column] === values[0]) };
        }

        const count = SELECT_COUNT.exec(query);

        if (count !== null) {
            const [, table = "", column = ""] = count;

            return { results: [{ count: rowsIn(tables, table).filter((row) => row[column] === values[0]).length }] };
        }

        const remove = DELETE_ROWS.exec(query);

        if (remove !== null) {
            const [, table = "", column = ""] = remove;
            const rows = rowsIn(tables, table);

            tables.set(
                table,
                rows.filter((row) => row[column] !== values[0]),
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

/** A fresh in-memory database with the three sign-in tables, and the binding that reads it. */
export const d1Double = (): { readonly db: AuthDatabase; readonly tables: Tables } => {
    const tables: Tables = new Map([
        ["account", []],
        ["session", []],
        ["user", []],
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

/** One subject's sign-in rows: a user, a session and a password account. */
export const seedSignIn = (tables: Tables, userId: string): void => {
    rowsIn(tables, "user").push({ email: `${userId}@example.test`, id: userId, name: userId });
    rowsIn(tables, "session").push({ id: `${userId}-session`, token: `${userId}-token`, userId });
    rowsIn(tables, "account").push({ id: `${userId}-account`, providerId: "credential", userId });
};
