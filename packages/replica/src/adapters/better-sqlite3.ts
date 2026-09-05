import { narrowSafeIntegers } from "./int64";
import type { SqliteAdapter } from "./types";

/**
 * Create a {@link SqliteAdapter} backed by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
 * (a synchronous SQLite3 binding for Node.js).
 *
 * The adapter takes a structural projection of better-sqlite3's `Database` so
 * the package never imports from `better-sqlite3` directly — consumers install
 * it themselves and pass in their database instance.
 * @param database An already-initialised better-sqlite3 `Database` instance.
 * @param database.close Tear down the database connection.
 * @param database.exec Execute one or more SQL statements (no params, no results).
 * @param database.prepare Prepare a SQL statement for repeated execution.
 * @param database.transaction Wrap a function so its statements run in a transaction.
 * @experimental
 */
export const createBetterSqlite3Adapter = (database: {
    close: () => void;
    exec: (sql: string) => void;
    prepare: (sql: string) => {
        all: (params?: unknown[]) => unknown[];
        get: (params?: unknown[]) => unknown;
        run: (params?: unknown[]) => { lastInsertRowid: number | bigint };
        safeIntegers: (toggle?: boolean) => unknown;
    };
    transaction: (function_: () => void) => () => void;
}): SqliteAdapter => {
    return {
        exec(sql: string, params?: ReadonlyArray<unknown>): void {
            if (params && params.length > 0) {
                database.prepare(sql).run([...params]);
            } else {
                database.exec(sql);
            }
        },

        query<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[] {
            const stmt = database.prepare(sql);

            // Decode INTEGER columns as `bigint` rather than through a double —
            // see `./int64`. `narrowSafeIntegers` puts an ordinary integer back
            // to a `number`, so only a real int64 stays wide.
            stmt.safeIntegers(true);

            const rows = params && params.length > 0 ? stmt.all([...params]) : stmt.all();

            return narrowSafeIntegers<T>(rows as Record<string, unknown>[]);
        },

        transaction(function_: () => void): void {
            const wrapped = database.transaction(function_);
            wrapped();
        },

        close(): void {
            database.close();
        },
    };
};
