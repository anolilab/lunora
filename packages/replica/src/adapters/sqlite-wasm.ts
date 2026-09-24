import { narrowSafeIntegers } from "./int64";
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
 * `Record<string, unknown>[]`. This adapter is written against that real shape.
 * @param database An already-initialised `sqlite3.oo1.DB` instance.
 * @param database.close Tear down the database connection.
 * @param database.exec Execute SQL with optional bind params. With
 * `{ returnValue: "resultRows", rowMode: "object" }` it returns the matched
 * rows directly (`Record<string, unknown>[]`); otherwise (DDL/DML/BEGIN/
 * COMMIT/ROLLBACK) its return value is unused here.
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

            // This build decodes an out-of-range INTEGER as a `bigint` on its
            // own (`bigIntEnabled`), so there is no per-call flag to set here —
            // only the same narrowing the other two adapters apply, so all
            // three agree on when a column is a `number` and when it is wide.
            return narrowSafeIntegers<T>(rows ?? []);
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

        close(): void {
            database.close();
        },
    };
};
