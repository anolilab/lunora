import type { SqliteAdapter } from "./types";

/**
 * Create a {@link SqliteAdapter} backed by the [official SQLite Wasm](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
 * (a WebAssembly build of SQLite that runs in browsers and Node.js).
 *
 * The adapter takes a structural projection of the OO API (`sqlite3.oo1.DB`) so
 * the package never imports from `@sqlite.org/sqlite-wasm` directly — consumers
 * install it themselves and pass in their database instance.
 *
 * IMPORTANT (REPLICA-01): the real `oo1.DB.exec()` does NOT return sql.js's
 * `{ columns, values }[]` result shape — with `rowMode: "object"` and
 * `returnValue: "resultRows"` it returns the rows directly, as
 * `Record&lt;string, unknown>[]`. This adapter is written against that real
 * shape; `lastInsertRowId` uses the driver's `selectValue()` convenience
 * method (a single-scalar query helper) rather than parsing a result-row
 * array.
 * @param database An already-initialised `sqlite3.oo1.DB` instance.
 * @param database.close Tear down the database connection.
 * @param database.exec Execute SQL with optional bind params. With
 * `{ returnValue: "resultRows", rowMode: "object" }` it returns the matched
 * rows directly (`Record&lt;string, unknown>[]`); otherwise (DDL/DML/BEGIN/
 * COMMIT/ROLLBACK) its return value is unused here.
 * @param database.selectValue Run a query and return the first column of the
 * first row as a single scalar — used for `SELECT last_insert_rowid()`.
 * @experimental
 */
export const createSqliteWasmAdapter = (database: {
    close: () => void;
    exec: (
        sql: string,
        options?: {
            bind?: unknown[];
            returnValue?: "resultRows";
            rowMode?: "object";
        },
    ) => Record<string, unknown>[] | undefined;
    selectValue: (sql: string, bind?: unknown[]) => unknown;
}): SqliteAdapter => {
    return {
        exec(sql: string, params?: ReadonlyArray<unknown>): void {
            if (params && params.length > 0) {
                database.exec(sql, { bind: [...params] });
            } else {
                database.exec(sql);
            }
        },

        query<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[] {
            const rows = database.exec(sql, {
                bind: params && params.length > 0 ? [...params] : undefined,
                returnValue: "resultRows",
                rowMode: "object",
            });

            return (rows ?? []) as T[];
        },

        transaction(function_: () => void): void {
            database.exec("BEGIN");
            try {
                function_();
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },

        lastInsertRowId(): number {
            const value = database.selectValue("SELECT last_insert_rowid()");

            if (typeof value === "number") {
                return value;
            }

            if (typeof value === "bigint") {
                return Number(value);
            }

            return -1;
        },

        close(): void {
            database.close();
        },
    };
};
