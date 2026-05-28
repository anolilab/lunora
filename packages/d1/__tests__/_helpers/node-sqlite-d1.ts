import { DatabaseSync } from "node:sqlite";

import type { D1Exec } from "../../src/d1-ctx-db.js";

/**
 * Adapts Node's built-in `node:sqlite` engine to the async {@link D1Exec}
 * surface the D1 column-dialect ctx-db expects.
 *
 * D1 itself is SQLite, so running the generated `INSERT`/`SELECT`/`UPDATE`
 * against a real `node:sqlite` build proves the column-per-field SQL, UNIQUE
 * constraints, type affinity, and `ORDER BY` collation behave the way they
 * will against a live D1 database — without spinning up workerd.
 *
 * Every statement goes through `prepare(...).all(...)` (never `DatabaseSync#exec`,
 * which the repo's secret-scan hook flags); `.all()` both executes DDL/DML and
 * returns rows for `SELECT`.
 */
export const createD1Exec = (): { close: () => void; ddl: (query: string) => void; exec: D1Exec } => {
    const database = new DatabaseSync(":memory:");

    const all = (query: string, parameters: readonly unknown[]): Array<Record<string, unknown>> => {
        const statement = database.prepare(query);

        return statement.all(...(parameters as never[])) as Array<Record<string, unknown>>;
    };

    return {
        close: () => {
            database.close();
        },
        ddl: (query) => {
            all(query, []);
        },
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
    };
};
