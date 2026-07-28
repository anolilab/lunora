import { DatabaseSync } from "node:sqlite";

import type { D1Exec } from "../../src/d1-ctx-db";

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
 *
 * One place the stand-in is *not* faithful: D1 always ships FTS5, and the D1
 * dialect says so, but whether `node:sqlite` carries the module depends on the
 * Node build (22.14 does not, 22.23 and 24 do). Suites that exercise the FTS5
 * shadow through the real D1 factory gate on {@link FTS5_IN_BUILD}; the ones
 * that override the dialect to the portable layout run everywhere.
 */
/** Whether this Node build's `node:sqlite` carries the FTS5 module. */
const FTS5_IN_BUILD = ((): boolean => {
    const database = new DatabaseSync(":memory:");

    try {
        database.prepare(`CREATE VIRTUAL TABLE "__fts5_build_probe__" USING fts5(x)`).all();

        return true;
    } catch {
        return false;
    } finally {
        database.close();
    }
})();

const createD1Exec = (): { close: () => void; ddl: (query: string) => void; exec: D1Exec } => {
    const database = new DatabaseSync(":memory:");

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => {
        const statement = database.prepare(query);

        return statement.all(...(parameters as never[]));
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

export { createD1Exec, FTS5_IN_BUILD };
